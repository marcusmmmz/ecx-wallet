//! `build_transfer(order, account_key)`: the wallet's own Send on eCash (#40, docs/adr/0006), as an
//! unsigned PSBT for the normal review.
//!
//! - Inputs: the account's coins, largest first, only as many as the payments and the fee need;
//!   each with the whole transaction holding it, so the Decoder reads its value, not the server's.
//! - Outputs: the payments in order, then change to the account's change address unless it would
//!   be dust, which goes to the fee. Change carries its derivation, so the Decoder shows it as yours.
//! - The replay marker, as every L1 spend: `nLockTime` is the network's `replayLockTime`, every
//!   `nSequence` non-final and replaceable (docs/adr/0004).
//! - Payments go to P2PKH, P2SH, P2WPKH, P2WSH or P2TR addresses in the network's encoding, which
//!   is Bitcoin's. A segwit version the chain doesn't define yet would be anyone's to spend: refused.
use std::str::FromStr;

use bitcoin::absolute::LockTime;
use bitcoin::bech32::{self, Hrp};
use bitcoin::consensus::encode::serialize;
use bitcoin::hashes::Hash;
use bitcoin::psbt::{Input, Output, Psbt};
use bitcoin::transaction::Version;
use bitcoin::{Amount, ScriptBuf, Transaction, TxIn, TxOut, WitnessProgram, WitnessVersion, Witness};
use serde::{Deserialize, Serialize};

use crate::deposit::{malformed, read_coins, spent_by, Coin, Spendable, Spent, SEQUENCE};
use crate::psbt::{refuse, Refusal, RefusalCode};
use crate::{network, AccountKeys};

/// Bitcoin Core's `DUST_RELAY_TX_FEE`, sats per 1000 vbytes (`src/policy/policy.h`), which eCash
/// keeps. Node relay policy, so not a Chain Entry value.
const DUST_RELAY_FEE: u64 = 3000;

/// What to send, and what to build it from.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TransferOrder {
    /// The account's coins to choose from (the wallet's rule: confirmed or trusted, none held back).
    pub coins: Vec<Coin>,
    pub outputs: Vec<Payment>,
    /// Sats per 1000 vbytes.
    pub fee_rate: u64,
    /// The change address's index (the account's first unused one, else its last).
    pub change_index: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Payment {
    /// Always "": eCash has only its coin.
    pub asset: String,
    /// Sats, as a decimal string.
    pub amount: String,
    pub to: PaymentTo,
}

/// Where a payment goes. Only addresses for now; scripts and data can join without breaking the order.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub enum PaymentTo {
    /// In eCash's encoding.
    Address(String),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuiltTransfer {
    /// Base64: a PSBT, under the name the wallet's `buildTransfer` gives every chain's payload.
    pub pset: String,
    /// The coins it spends: what the wallet holds back from later spends until this one confirms.
    pub spent: Vec<Spent>,
}

/// `sats` as the user reads it.
fn ecx(sats: u64) -> String {
    format!("{}.{:08} ECX", sats / 100_000_000, sats % 100_000_000)
}

/// Bitcoin Core's `GetDustThreshold` at its `DUST_RELAY_TX_FEE`: what it costs to spend `txout`,
/// rounded up. Below it, an output isn't relayed.
fn dust_threshold(txout: &TxOut) -> u64 {
    let spend = if txout.script_pubkey.is_witness_program() { 32 + 4 + 1 + 107 / 4 + 4 } else { 32 + 4 + 1 + 107 + 4 };
    ((serialize(txout).len() + spend) as u64 * DUST_RELAY_FEE).div_ceil(1000)
}

/// `address`'s script, if it is an address of this network the wallet pays: P2PKH and P2SH in
/// base58check, segwit v0 (P2WPKH, P2WSH) and v1 (P2TR) in bech32/bech32m.
pub(crate) fn script_of(address: &str) -> Option<ScriptBuf> {
    let params = &network().params.address_params;
    if let Ok((hrp, version, program)) = bech32::segwit::decode(address) {
        if hrp != Hrp::parse(&params.bech_hrp).ok()? {
            return None;
        }
        let version = WitnessVersion::try_from(version).ok()?;
        let program = WitnessProgram::new(version, &program).ok()?;
        let known = match version {
            WitnessVersion::V0 => true,
            WitnessVersion::V1 => program.program().len() == 32,
            _ => false,
        };
        return known.then(|| ScriptBuf::new_witness_program(&program));
    }
    let data = bitcoin::base58::decode_check(address).ok()?;
    let (prefix, hash) = data.split_first()?;
    let hash: [u8; 20] = hash.try_into().ok()?;
    match *prefix {
        p if p == params.p2pkh_prefix => Some(ScriptBuf::new_p2pkh(&bitcoin::PubkeyHash::from_byte_array(hash))),
        p if p == params.p2sh_prefix => Some(ScriptBuf::new_p2sh(&bitcoin::ScriptHash::from_byte_array(hash))),
        _ => None,
    }
}

pub fn build_transfer(order_json: &str, account_key: &str) -> Result<BuiltTransfer, Refusal> {
    let order: TransferOrder = serde_json::from_str(order_json).map_err(|e| malformed(format!("Invalid transfer order: {e}")))?;
    let keys = AccountKeys::new(account_key).map_err(|e| refuse(RefusalCode::InvalidAccountKey, e))?;
    if order.outputs.is_empty() {
        return Err(malformed("A transfer needs at least one output."));
    }

    let mut payments = vec![];
    let mut need = 0u64;
    for (i, payment) in order.outputs.iter().enumerate() {
        if !payment.asset.is_empty() {
            return Err(malformed(format!("Output {i}: eCash has no asset {}, only its own coin.", payment.asset)));
        }
        let PaymentTo::Address(address) = &payment.to;
        let script = script_of(address.trim()).ok_or_else(|| malformed(format!("Output {i}: {address} isn't an eCash address this wallet pays.")))?;
        let amount = u64::from_str(&payment.amount)
            .ok()
            .filter(|a| *a > 0)
            .ok_or_else(|| malformed(format!("Output {i}'s amount must be a whole number of sats above 0.")))?;
        let txout = TxOut { value: Amount::from_sat(amount), script_pubkey: script };
        let dust = dust_threshold(&txout);
        if amount < dust {
            return Err(refuse(RefusalCode::Dust, format!("{} is below the smallest amount eCash relays to {address} ({}).", ecx(amount), ecx(dust))));
        }
        need = need.checked_add(amount).ok_or_else(|| malformed("The amounts are too large."))?;
        payments.push(txout);
    }

    let coins = read_coins(&order.coins, &keys)?;
    let change_script = keys.script(1, order.change_index).map_err(|e| refuse(RefusalCode::InvalidAccountKey, e))?;
    let change_output = |value: u64| TxOut { value: Amount::from_sat(value), script_pubkey: change_script.clone() };
    let change_dust = dust_threshold(&change_output(0));
    let unsigned = |chosen: &[Spendable], change: Option<u64>| {
        let input = chosen.iter().map(|coin| TxIn { previous_output: coin.outpoint, script_sig: ScriptBuf::new(), sequence: SEQUENCE, witness: Witness::new() }).collect();
        let mut output = payments.clone();
        output.extend(change.map(change_output));
        Transaction { version: Version::TWO, lock_time: LockTime::from_consensus(network().params.replay_lock_time), input, output }
    };
    // The fee for `tx` once signed: every P2WPKH input gets a witness of the largest size it can have.
    let fee = |tx: &Transaction| {
        let mut signed = tx.clone();
        for input in &mut signed.input {
            input.witness = Witness::from_slice(&[vec![0u8; 72], vec![0u8; 33]]);
        }
        (signed.weight().to_wu().div_ceil(4) * order.fee_rate).div_ceil(1000)
    };

    let mut total = 0u64;
    for count in 1..=coins.len() {
        total += coins[count - 1].txout.value.to_sat();
        let chosen = &coins[..count];
        let with_change = fee(&unsigned(chosen, Some(0)));
        if let Some(change) = total.checked_sub(need + with_change).filter(|change| *change >= change_dust) {
            return psbt(unsigned(chosen, Some(change)), chosen, Some(order.change_index), &keys);
        }
        if total >= need + fee(&unsigned(chosen, None)) {
            // Change too small to relay goes to the fee.
            return psbt(unsigned(chosen, None), chosen, None, &keys);
        }
    }
    let needed = need + fee(&unsigned(&coins, None));
    Err(refuse(
        RefusalCode::InsufficientFunds,
        format!("Not enough ECX: this needs {} with its fee, and the wallet can spend {}.", ecx(needed), ecx(total)),
    ))
}

/// `tx` as a PSBT spending `chosen` (in input order), its last output the change at `change_index`.
fn psbt(tx: Transaction, chosen: &[Spendable], change_index: Option<u32>, keys: &AccountKeys) -> Result<BuiltTransfer, Refusal> {
    let key_error = |e: String| refuse(RefusalCode::InvalidAccountKey, e);
    let mut psbt = Psbt::from_unsigned_tx(tx).map_err(|e| malformed(format!("Can't build the PSBT: {e}")))?;
    for (input, coin) in psbt.inputs.iter_mut().zip(chosen) {
        let pubkey = keys.public_key(coin.chain, coin.index).map_err(key_error)?;
        *input = Input {
            non_witness_utxo: Some(coin.tx.clone()),
            witness_utxo: Some(coin.txout.clone()),
            bip32_derivation: [(pubkey, (keys.fingerprint, keys.path(coin.chain, coin.index)))].into(),
            ..Input::default()
        };
    }
    if let Some(index) = change_index {
        let pubkey = keys.public_key(1, index).map_err(key_error)?;
        let last = psbt.outputs.len() - 1;
        psbt.outputs[last] = Output { bip32_derivation: [(pubkey, (keys.fingerprint, keys.path(1, index)))].into(), ..Output::default() };
    }
    Ok(BuiltTransfer { pset: psbt.to_string(), spent: spent_by(chosen) })
}
