//! `build_transfer(order, starter)`: the wallet's own Send of ECX and asset tokens (docs/adr/0006,
//! docs/adr/0013), as an unsigned PSBT for the normal review.
//!
//! - Inputs: for each asset sent, the account's coins carrying it, largest first, then coins with
//!   value for the ECX payments and the fee, largest first; each with the whole transaction holding
//!   it. What a coin of value 0 carries is read from that transaction's `BAST` marker, never from the
//!   server. Only the sent assets' coins are spent: never a control coin, LP shares, a position, an
//!   order or a result, since a transaction must list every token it spends again
//!   (`bad-ba-tokens-lost`). A Send of ECX alone spends no coin of value 0, so it needs no marker.
//! - Outputs: the payments in order (a token's at value 0), then each sent asset's change, then the
//!   marker listing every token output (kind 0, a transfer), then the ECX change unless it would be
//!   dust, which goes to the fee. Change carries its derivation, so the Decoder shows it as yours.
//! - Token coins must be confirmed (the mempool refuses `ba-token-unconfirmed`): the wallet only
//!   offers confirmed ones.
//! - Version 2, `nLockTime` 0, every `nSequence` replaceable: no replay marker (docs/adr/0011).
//!
//! Every value and script is read from the transactions it is handed, never from what the server
//! said about them.
use std::str::FromStr;

use bitcoin::absolute::LockTime;
use bitcoin::consensus::encode::{deserialize_hex, serialize};
use bitcoin::psbt::{Input, Output, Psbt};
use bitcoin::transaction::Version;
use std::collections::BTreeMap;

use bitcoin::{Amount, OutPoint, ScriptBuf, Sequence, Transaction, TxIn, TxOut, Witness};
use serde::{Deserialize, Serialize};

use crate::bast::{self, TokenKind};
use crate::psbt::{refuse, Refusal, RefusalCode};
use crate::{script_of, tokens, AccountKeys};

/// Every input's `nSequence`: replaceable, as Bitcoin Core's wallet sets it.
const SEQUENCE: Sequence = Sequence::ENABLE_RBF_NO_LOCKTIME;

/// Flush Core's `DUST_RELAY_TX_FEE`, sats per 1000 vbytes (`src/policy/policy.h`, as Bitcoin's).
/// Node relay policy, so not a Chain Entry value.
const DUST_RELAY_FEE: u64 = 3000;

/// The lowest fee rate a Send pays, sats per 1000 vbytes: 1 sat/vB. Flush relays from 0.1
/// (`DEFAULT_MIN_RELAY_TX_FEE`), and its explorer's `/fee-estimates` reports that floor while blocks
/// have room, but Flush Core's own wallet pays 20. Provisional: the fee rate third-party wallets
/// should use was asked of Flush's developer on 2026-10-25 (#56).
const MIN_FEE_RATE: u64 = 1000;

/// What to send, and what to build it from.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TransferOrder {
    /// The account's coins to choose from (the wallet's rule: confirmed or trusted, none held back).
    pub coins: Vec<Coin>,
    pub outputs: Vec<Payment>,
    /// Sats per 1000 vbytes; a Send pays at least 1000.
    pub fee_rate: u64,
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
pub struct Payment {
    /// "" for ECX, the native coin; else an asset's id (display hex), sent as its tokens.
    pub asset: String,
    /// Sats, or the asset's base units, as a decimal string.
    pub amount: String,
    pub to: PaymentTo,
}

/// Where a payment goes. Only addresses for now; scripts and data can join without breaking the order.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub enum PaymentTo {
    /// In Flush's encoding.
    Address(String),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Built {
    /// Base64: a PSBT, under the name the wallet's `buildTransfer` gives every chain's payload.
    pub pset: String,
    /// The coins it spends: what the wallet holds back from later transfers until this one confirms.
    pub spent: Vec<Spent>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Spent {
    /// Display hex.
    pub txid: String,
    pub vout: u32,
}

fn malformed(message: impl Into<String>) -> Refusal {
    refuse(RefusalCode::Malformed, message)
}

fn starter_refusal(message: String) -> Refusal {
    refuse(RefusalCode::InvalidStarter, message)
}

/// `sats` as the user reads it.
fn ecx(sats: u64) -> String {
    format!("{}.{:08} ECX", sats / 100_000_000, sats % 100_000_000)
}

/// Flush Core's `GetDustThreshold` at its `DUST_RELAY_TX_FEE`: what it costs to spend `txout`,
/// rounded up. Below it, an output isn't relayed.
pub(crate) fn dust_threshold(txout: &TxOut) -> u64 {
    if txout.script_pubkey.is_op_return() {
        return 0;
    }
    let spend = if txout.script_pubkey.is_witness_program() { 32 + 4 + 1 + 107 / 4 + 4 } else { 32 + 4 + 1 + 107 + 4 };
    ((serialize(txout).len() + spend) as u64 * DUST_RELAY_FEE).div_ceil(1000)
}

/// One of the account's coins, read from its transaction.
struct Spendable {
    outpoint: OutPoint,
    tx: Transaction,
    txout: TxOut,
    chain: u32,
    index: u32,
}

/// The highest token amount Flush accepts (`MAX_AMOUNT`, backbone-flush `state.h`: 2^63 - 1).
const MAX_TOKEN_AMOUNT: u64 = i64::MAX as u64;

pub fn build_transfer(order_json: &str, starter: &str) -> Result<Built, Refusal> {
    let order: TransferOrder = serde_json::from_str(order_json).map_err(|e| malformed(format!("Invalid transfer order: {e}")))?;
    let keys = AccountKeys::new(starter).map_err(starter_refusal)?;
    if order.outputs.is_empty() {
        return Err(malformed("A transfer needs at least one output."));
    }
    let fee_rate = order.fee_rate.max(MIN_FEE_RATE);

    let mut payments = vec![];
    let mut need = 0u64;
    // Per asset sent: the units its payments add up to. Each token payment, as (output, asset, units).
    let mut need_tokens: BTreeMap<String, u64> = BTreeMap::new();
    let mut listed: Vec<(u32, String, u64)> = vec![];
    for (i, payment) in order.outputs.iter().enumerate() {
        let PaymentTo::Address(address) = &payment.to;
        let script = script_of(address.trim()).ok_or_else(|| malformed(format!("Output {i}: {address} isn't a Flush address.")))?;
        if !payment.asset.is_empty() {
            let asset = payment.asset.to_ascii_lowercase();
            if asset.len() != 64 || !asset.bytes().all(|b| b.is_ascii_hexdigit()) {
                return Err(malformed(format!("Output {i}: {} isn't an asset id.", payment.asset)));
            }
            let units = u64::from_str(&payment.amount)
                .ok()
                .filter(|a| (1..=MAX_TOKEN_AMOUNT).contains(a))
                .ok_or_else(|| malformed(format!("Output {i}'s amount must be a whole number of units, from 1 to {MAX_TOKEN_AMOUNT}.")))?;
            let total = need_tokens.entry(asset.clone()).or_default();
            *total = total.checked_add(units).filter(|t| *t <= MAX_TOKEN_AMOUNT).ok_or_else(|| malformed("The amounts are too large."))?;
            listed.push((i as u32, asset, units));
            // A token's output: value 0, which relay policy never counts as dust.
            payments.push(TxOut { value: Amount::ZERO, script_pubkey: script });
            continue;
        }
        let amount = u64::from_str(&payment.amount)
            .ok()
            .filter(|a| *a > 0)
            .ok_or_else(|| malformed(format!("Output {i}'s amount must be a whole number of sats above 0.")))?;
        let txout = TxOut { value: Amount::from_sat(amount), script_pubkey: script };
        let dust = dust_threshold(&txout);
        if amount < dust {
            return Err(refuse(RefusalCode::Dust, format!("{} is below the smallest amount Flush relays to {address} ({}).", ecx(amount), ecx(dust))));
        }
        need = need.checked_add(amount).ok_or_else(|| malformed("The amounts are too large."))?;
        payments.push(txout);
    }

    let mut coins: Vec<Spendable> = vec![];
    // Coins of a sent asset, with the units each carries.
    let mut token_coins: BTreeMap<String, Vec<(Spendable, u64)>> = BTreeMap::new();
    let mut outpoints = vec![];
    for (i, coin) in order.coins.iter().enumerate() {
        let tx = deserialize_hex::<Transaction>(&coin.tx).map_err(|e| malformed(format!("Coin {i}'s transaction isn't one: {e}")))?;
        let txout = tx.output.get(coin.vout as usize).cloned().ok_or_else(|| malformed(format!("Coin {i}'s transaction has no output {}.", coin.vout)))?;
        let ours = (coin.chain <= 1).then(|| keys.script(coin.chain, coin.index).ok()).flatten();
        if ours.as_ref() != Some(&txout.script_pubkey) {
            return Err(malformed(format!("Coin {i} doesn't pay this account's address {}/{}.", coin.chain, coin.index)));
        }
        let outpoint = OutPoint { txid: tx.compute_txid(), vout: coin.vout };
        if outpoints.contains(&outpoint) {
            return Err(malformed(format!("Coin {i} is listed twice.")));
        }
        outpoints.push(outpoint);
        if txout.value == Amount::ZERO {
            // A token's output, or a block's empty fee output: spent only if it carries an asset
            // this Send moves, as its transaction's marker says.
            if need_tokens.is_empty() {
                continue;
            }
            let carried = tokens::listed_on(&tx, coin.vout)?.and_then(|l| l.token);
            if let Some(bast::Token { kind: TokenKind::Asset, id, amount }) = carried {
                if need_tokens.contains_key(&id) {
                    token_coins.entry(id).or_default().push((Spendable { outpoint, tx, txout, chain: coin.chain, index: coin.index }, amount));
                }
            }
            continue;
        }
        coins.push(Spendable { outpoint, tx, txout, chain: coin.chain, index: coin.index });
    }
    coins.sort_by(|a, b| b.txout.value.cmp(&a.txout.value).then(a.outpoint.cmp(&b.outpoint)));

    let change_script = keys.script(1, order.change_index).map_err(starter_refusal)?;
    let change_output = |value: u64| TxOut { value: Amount::from_sat(value), script_pubkey: change_script.clone() };

    // Each asset's coins, largest first until they cover its payments; what's left over comes back.
    let mut token_inputs: Vec<Spendable> = vec![];
    let mut fixed = payments.clone();
    for (asset, needed) in &need_tokens {
        let mut held = token_coins.remove(asset).unwrap_or_default();
        held.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.outpoint.cmp(&b.0.outpoint)));
        let available: u64 = held.iter().map(|(_, units)| units).sum();
        if available < *needed {
            return Err(refuse(
                RefusalCode::InsufficientFunds,
                format!("Not enough of asset {asset}: this sends {needed} units, and the wallet can spend {available}."),
            ));
        }
        let mut total = 0u64;
        for (coin, units) in held {
            if total >= *needed {
                break;
            }
            total += units;
            token_inputs.push(coin);
        }
        if total > *needed {
            listed.push((fixed.len() as u32, asset.clone(), total - needed));
            fixed.push(change_output(0));
        }
    }
    let token_change: Vec<usize> = (payments.len()..fixed.len()).collect();
    if !listed.is_empty() {
        listed.sort_by_key(|(n, _, _)| *n);
        let entries: Vec<(u32, &str, u64)> = listed.iter().map(|(n, asset, units)| (*n, asset.as_str(), *units)).collect();
        let marker = bast::transfer_marker(&entries).map_err(|e| malformed(format!("Can't write the transfer's marker: {e}.")))?;
        fixed.push(TxOut { value: Amount::ZERO, script_pubkey: ScriptBuf::from_bytes(marker) });
    }

    let change_dust = dust_threshold(&change_output(0));
    let unsigned = |chosen: &[Spendable], change: Option<u64>| {
        let input = token_inputs
            .iter()
            .chain(chosen)
            .map(|coin| TxIn { previous_output: coin.outpoint, script_sig: ScriptBuf::new(), sequence: SEQUENCE, witness: Witness::new() })
            .collect();
        let mut output = fixed.clone();
        output.extend(change.map(change_output));
        Transaction { version: Version::TWO, lock_time: LockTime::ZERO, input, output }
    };
    // The fee for `tx` once signed: every input gets a witness of the largest size it can have.
    let fee = |tx: &Transaction| {
        let mut signed = tx.clone();
        for input in &mut signed.input {
            input.witness = Witness::from_slice(&[vec![0u8; 72], vec![0u8; 33]]);
        }
        (signed.weight().to_wu().div_ceil(4) * fee_rate).div_ceil(1000)
    };
    fn inputs<'a>(tokens: &'a [Spendable], chosen: &'a [Spendable]) -> Vec<&'a Spendable> {
        tokens.iter().chain(chosen).collect()
    }

    let mut total = 0u64;
    for count in 1..=coins.len() {
        total += coins[count - 1].txout.value.to_sat();
        let chosen = &coins[..count];
        let with_change = fee(&unsigned(chosen, Some(0)));
        if let Some(change) = total.checked_sub(need + with_change).filter(|change| *change >= change_dust) {
            let tx = unsigned(chosen, Some(change));
            let ecx_change = tx.output.len() - 1;
            return psbt(tx, &inputs(&token_inputs, chosen), &[token_change.as_slice(), &[ecx_change]].concat(), order.change_index, &keys);
        }
        if total >= need + fee(&unsigned(chosen, None)) {
            // Change too small to relay goes to the fee.
            return psbt(unsigned(chosen, None), &inputs(&token_inputs, chosen), &token_change, order.change_index, &keys);
        }
    }
    let needed = need + fee(&unsigned(&coins, None));
    Err(refuse(
        RefusalCode::InsufficientFunds,
        format!("Not enough ECX: this needs {} with its fee, and the wallet can spend {}.", ecx(needed), ecx(total)),
    ))
}

/// `tx` as a PSBT spending `chosen` (in input order), with the derivation of change address
/// `change_index` on each of the `change` outputs.
fn psbt(tx: Transaction, chosen: &[&Spendable], change: &[usize], change_index: u32, keys: &AccountKeys) -> Result<Built, Refusal> {
    let mut psbt = Psbt::from_unsigned_tx(tx).map_err(|e| malformed(format!("Can't build the PSBT: {e}")))?;
    for (input, coin) in psbt.inputs.iter_mut().zip(chosen) {
        let pubkey = keys.public_key(coin.chain, coin.index).map_err(starter_refusal)?;
        *input = Input {
            non_witness_utxo: Some(coin.tx.clone()),
            witness_utxo: Some(coin.txout.clone()),
            bip32_derivation: [(pubkey, keys.key_source(coin.chain, coin.index))].into(),
            ..Input::default()
        };
    }
    let pubkey = keys.public_key(1, change_index).map_err(starter_refusal)?;
    for &index in change {
        psbt.outputs[index] = Output { bip32_derivation: [(pubkey, keys.key_source(1, change_index))].into(), ..Output::default() };
    }
    let spent = chosen.iter().map(|coin| Spent { txid: coin.outpoint.txid.to_string(), vout: coin.outpoint.vout }).collect();
    Ok(Built { pset: psbt.to_string(), spent })
}
