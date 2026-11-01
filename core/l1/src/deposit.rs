//! `build_deposit(order, account_key)`: an M5, the L1 transaction that deposits to a Slot (BIP300;
//! the enforcer's `create_deposit_psbt`), as an unsigned PSBT for the normal review.
//!
//! - Inputs: the Slot's Treasury, if it has one (empty scriptSig), then the account's own coins.
//! - Outputs: the new Treasury `OP_DRIVECHAIN <slot> OP_TRUE` holding the old value plus the
//!   amount, then directly after it a single-push `OP_RETURN` with the destination bytes (the Slot's
//!   Chain Module's `depositDestination`), then change if any.
//! - The replay marker: `nLockTime` is the network's `replayLockTime`, every `nSequence` non-final.
//!
//! The module picks the coins (largest first) and computes the fee. It reads every value and script
//! from the transactions it is handed, never from what the server said about them.
use std::str::FromStr;

use bitcoin::absolute::LockTime;
use bitcoin::consensus::encode::deserialize_hex;
use bitcoin::psbt::{Input, Output, Psbt};
use bitcoin::script::PushBytesBuf;
use bitcoin::transaction::Version;
use bitcoin::{Amount, OutPoint, ScriptBuf, Sequence, Transaction, TxIn, TxOut, Witness};
use serde::{Deserialize, Serialize};

use crate::psbt::{refuse, treasury_script_of, Refusal, RefusalCode};
use crate::{hex, network, AccountKeys};

/// Every input's `nSequence`: non-final (the replay marker) and opting in to replacement, as
/// Bitcoin Core's wallet does.
pub(crate) const SEQUENCE: Sequence = Sequence::ENABLE_RBF_NO_LOCKTIME;

/// Change below this is left to the fee rather than paid to a change address.
const MIN_CHANGE: u64 = 546;

/// The longest destination: Backbone's `MAX_DEPOSIT_DESTINATION_SIZE` (`src/drivechain/sidechain.h`),
/// its RPC's cap, and consensus once `limits_activation_height` is set (#57).
const MAX_DESTINATION_BYTES: usize = 100;

/// The largest M5 Backbone's mempool takes (`dc-tx-too-large`), and the largest that spends an
/// unconfirmed Treasury (`dc-unconfirmed-parent`), in vbytes (`src/policy/truc_policy.h`, #57).
const MAX_DEPOSIT_VSIZE: u64 = 10_000;
const MAX_CHAINED_DEPOSIT_VSIZE: u64 = 1_000;

/// What to deposit, and what to build it from.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DepositOrder {
    pub slot: u8,
    /// Sats, as a decimal string: what the Treasury grows by.
    pub amount: String,
    /// Hex: the bytes the Slot credits the Deposit to (its Chain Module's `depositDestination`).
    pub destination: String,
    /// Sats per 1000 vbytes.
    pub fee_rate: u64,
    /// The account's coins to choose from (confirmed ones: the wallet's rule).
    pub coins: Vec<Coin>,
    /// The Slot's current Treasury, or none for its first Deposit.
    pub treasury: Option<PrevOut>,
    /// The change address's index (the account's first unused one).
    pub change_index: u32,
}

/// One of the account's outputs: the transaction holding it, and which address it pays.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Coin {
    /// The whole transaction, hex.
    pub tx: String,
    pub vout: u32,
    /// 0 receive, 1 change.
    pub chain: u32,
    pub index: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PrevOut {
    /// The whole transaction, hex.
    pub tx: String,
    pub vout: u32,
    /// The Treasury is a pending M5's: Backbone takes an M5 spending it only up to 1,000 vB.
    #[serde(default)]
    pub unconfirmed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Built {
    /// Base64.
    pub psbt: String,
    /// The account's coins it spends (not the Treasury): what the wallet holds back from later spends.
    pub spent: Vec<Spent>,
}

/// One of the account's outputs a built transaction spends.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Spent {
    /// Display hex.
    pub txid: String,
    pub vout: u32,
}

/// The Treasury script of `slot` on this network, hex: what the wallet looks the Treasury up by.
pub fn treasury_script(slot: u32) -> Result<String, String> {
    let slot = u8::try_from(slot).map_err(|_| format!("{slot} isn't a Slot (0-255)"))?;
    Ok(hex(treasury_script_of(slot).as_bytes()))
}

/// A raw transaction's txid: what the wallet checks before it keeps a transaction for the session.
pub fn txid(tx: &str) -> Result<String, String> {
    deserialize_hex::<Transaction>(tx).map(|tx| tx.compute_txid().to_string()).map_err(|e| format!("not a transaction: {e}"))
}

/// One of the account's coins, read from its transaction.
pub(crate) struct Spendable {
    pub outpoint: OutPoint,
    pub tx: Transaction,
    pub txout: TxOut,
    pub chain: u32,
    pub index: u32,
}

pub(crate) fn malformed(message: impl Into<String>) -> Refusal {
    refuse(RefusalCode::Malformed, message)
}

/// `coins` read from their transactions, largest first: each must pay the account's address it
/// names, and none may be listed twice.
pub(crate) fn read_coins(coins: &[Coin], keys: &AccountKeys) -> Result<Vec<Spendable>, Refusal> {
    let mut read: Vec<Spendable> = vec![];
    for (i, coin) in coins.iter().enumerate() {
        let tx = parse_tx(&coin.tx, &format!("Coin {i}'s transaction"))?;
        let txout = tx.output.get(coin.vout as usize).cloned().ok_or_else(|| malformed(format!("Coin {i}'s transaction has no output {}.", coin.vout)))?;
        let ours = (coin.chain <= 1).then(|| keys.script(coin.chain, coin.index).ok()).flatten();
        if ours.as_ref() != Some(&txout.script_pubkey) {
            return Err(malformed(format!("Coin {i} doesn't pay this account's address {}/{}.", coin.chain, coin.index)));
        }
        let outpoint = OutPoint { txid: tx.compute_txid(), vout: coin.vout };
        if read.iter().any(|c| c.outpoint == outpoint) {
            return Err(malformed(format!("Coin {i} is listed twice.")));
        }
        read.push(Spendable { outpoint, tx, txout, chain: coin.chain, index: coin.index });
    }
    read.sort_by(|a, b| b.txout.value.cmp(&a.txout.value).then(a.outpoint.cmp(&b.outpoint)));
    Ok(read)
}

/// What `chosen` spends, as `Built` names it.
pub(crate) fn spent_by(chosen: &[Spendable]) -> Vec<Spent> {
    chosen.iter().map(|coin| Spent { txid: coin.outpoint.txid.to_string(), vout: coin.outpoint.vout }).collect()
}

fn parse_tx(tx: &str, what: &str) -> Result<Transaction, Refusal> {
    deserialize_hex::<Transaction>(tx).map_err(|e| malformed(format!("{what} isn't a transaction: {e}")))
}

pub fn build_deposit(order_json: &str, account_key: &str) -> Result<Built, Refusal> {
    let order: DepositOrder = serde_json::from_str(order_json).map_err(|e| malformed(format!("Invalid deposit order: {e}")))?;
    let keys = AccountKeys::new(account_key).map_err(|e| refuse(RefusalCode::InvalidAccountKey, e))?;
    let amount = u64::from_str(&order.amount).ok().filter(|a| *a > 0).ok_or_else(|| malformed("The amount must be a whole number of sats above 0."))?;
    let destination = (bitcoin::hex::FromHex::from_hex(&order.destination).ok() as Option<Vec<u8>>)
        .filter(|d| !d.is_empty() && d.len() <= MAX_DESTINATION_BYTES)
        .and_then(|d| PushBytesBuf::try_from(d).ok())
        .ok_or_else(|| malformed(format!("The destination must be 1 to {MAX_DESTINATION_BYTES} bytes of hex.")))?;

    let coins = read_coins(&order.coins, &keys)?;

    let treasury_script = treasury_script_of(order.slot);
    let treasury = order
        .treasury
        .as_ref()
        .map(|prev| {
            let tx = parse_tx(&prev.tx, "The Treasury's transaction")?;
            let txout = tx.output.get(prev.vout as usize).cloned().ok_or_else(|| malformed(format!("The Treasury's transaction has no output {}.", prev.vout)))?;
            if txout.script_pubkey != treasury_script {
                return Err(malformed(format!("The Treasury output doesn't pay Slot {}'s Treasury script.", order.slot)));
            }
            Ok((OutPoint { txid: tx.compute_txid(), vout: prev.vout }, tx, txout))
        })
        .transpose()?;
    let before = treasury.as_ref().map_or(0, |(_, _, txout)| txout.value.to_sat());
    let new_treasury = before.checked_add(amount).ok_or_else(|| malformed("The amount is too large."))?;

    let change_script = keys.script(1, order.change_index).map_err(|e| refuse(RefusalCode::InvalidAccountKey, e))?;
    let unsigned = |chosen: &[Spendable], change: Option<u64>| {
        let mut input: Vec<TxIn> = vec![];
        if let Some((outpoint, _, _)) = &treasury {
            input.push(TxIn { previous_output: *outpoint, script_sig: ScriptBuf::new(), sequence: SEQUENCE, witness: Witness::new() });
        }
        input.extend(chosen.iter().map(|coin| TxIn { previous_output: coin.outpoint, script_sig: ScriptBuf::new(), sequence: SEQUENCE, witness: Witness::new() }));
        let mut output = vec![
            TxOut { value: Amount::from_sat(new_treasury), script_pubkey: treasury_script.clone() },
            TxOut { value: Amount::ZERO, script_pubkey: ScriptBuf::new_op_return(&destination) },
        ];
        if let Some(change) = change {
            output.push(TxOut { value: Amount::from_sat(change), script_pubkey: change_script.clone() });
        }
        Transaction { version: Version::TWO, lock_time: LockTime::from_consensus(network().params.replay_lock_time), input, output }
    };
    // The size of `tx` once signed: every P2WPKH input gets a witness of the largest size it can have.
    let vsize = |tx: &Transaction| {
        let mut signed = tx.clone();
        let treasury_inputs = usize::from(treasury.is_some());
        for input in signed.input.iter_mut().skip(treasury_inputs) {
            input.witness = Witness::from_slice(&[vec![0u8; 72], vec![0u8; 33]]);
        }
        signed.weight().to_wu().div_ceil(4)
    };
    let fee = |tx: &Transaction| (vsize(tx) * order.fee_rate).div_ceil(1000);
    let chained = order.treasury.as_ref().is_some_and(|t| t.unconfirmed);
    let limit = if chained { MAX_CHAINED_DEPOSIT_VSIZE } else { MAX_DEPOSIT_VSIZE };

    let mut total = 0u64;
    for count in 1..=coins.len() {
        total += coins[count - 1].txout.value.to_sat();
        let chosen = &coins[..count];
        let size = vsize(&unsigned(chosen, Some(0)));
        if size > limit {
            let (which, or) = if chained { (" that spends an unconfirmed Treasury", ", or wait for the Treasury to confirm") } else { ("", "") };
            return Err(refuse(
                RefusalCode::TooLarge,
                format!("This Deposit would take {count} coins and {size} vB: eCash relays at most {limit} vB for a Deposit{which}. Deposit less{or}."),
            ));
        }
        let with_change = fee(&unsigned(chosen, Some(0)));
        if let Some(change) = total.checked_sub(amount + with_change).filter(|change| *change >= MIN_CHANGE) {
            return psbt(unsigned(chosen, Some(change)), chosen, &treasury, Some(order.change_index), &keys);
        }
        if total >= amount + fee(&unsigned(chosen, None)) {
            return psbt(unsigned(chosen, None), chosen, &treasury, None, &keys);
        }
    }
    let needed = amount + fee(&unsigned(&coins, None));
    Err(refuse(
        RefusalCode::InsufficientFunds,
        format!("Not enough confirmed eCash: the deposit needs {needed} sats with its fee, and the wallet has {total}."),
    ))
}

fn psbt(
    tx: Transaction,
    chosen: &[Spendable],
    treasury: &Option<(OutPoint, Transaction, TxOut)>,
    change_index: Option<u32>,
    keys: &AccountKeys,
) -> Result<Built, Refusal> {
    let mut psbt = Psbt::from_unsigned_tx(tx).map_err(|e| malformed(format!("Can't build the PSBT: {e}")))?;
    let mut inputs = vec![];
    if let Some((_, tx, _)) = treasury {
        inputs.push(Input { non_witness_utxo: Some(tx.clone()), final_script_sig: Some(ScriptBuf::new()), ..Input::default() });
    }
    for coin in chosen {
        let pubkey = keys.public_key(coin.chain, coin.index).map_err(|e| refuse(RefusalCode::InvalidAccountKey, e))?;
        inputs.push(Input {
            non_witness_utxo: Some(coin.tx.clone()),
            witness_utxo: Some(coin.txout.clone()),
            bip32_derivation: [(pubkey, (keys.fingerprint, keys.path(coin.chain, coin.index)))].into(),
            ..Input::default()
        });
    }
    psbt.inputs = inputs;
    if let Some(index) = change_index {
        let pubkey = keys.public_key(1, index).map_err(|e| refuse(RefusalCode::InvalidAccountKey, e))?;
        psbt.outputs[2] = Output { bip32_derivation: [(pubkey, (keys.fingerprint, keys.path(1, index)))].into(), ..Output::default() };
    }
    Ok(Built { psbt: psbt.to_string(), spent: spent_by(chosen) })
}
