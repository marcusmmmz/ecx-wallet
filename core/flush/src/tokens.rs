//! Tokens on Flush outputs, read from the transaction that made them (docs/adr/0013).
//!
//! Flush's explorer lists a token output as a plain output of value 0: only the `BAST` marker of
//! the transaction that created it says what it carries. The wallet hands the module that whole
//! transaction; the module computes its txid itself, so a server can't pass one transaction off as
//! another.
//!
//! - [`output_tokens`]: each output the marker lists, with its token, or as a result, which only the
//!   node's state knows (swaps, pool withdrawals, …).
//! - [`asset_registration`]: an asset's name and decimals from the transaction that registered it,
//!   only if it registers that very id and the ticker hashes to it (`HashName`).
use bitcoin::consensus::encode::deserialize_hex;
use bitcoin::Transaction;
use serde::Serialize;

use crate::bast::{self, Marker};
use crate::psbt::{refuse, Refusal, RefusalCode};

/// The highest `decimals` a registration may have (`MAX_DECIMALS`, backbone-flush `state.h`).
pub const MAX_DECIMALS: u8 = 12;

/// What a transaction's marker puts on its outputs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputTokens {
    /// The transaction's txid, display order, as the module computed it.
    pub txid: String,
    /// Every output the marker lists, in output order; none if the transaction has no marker.
    pub outputs: Vec<OutputToken>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputToken {
    pub vout: u32,
    /// The token it carries; absent for a result, which the transaction alone can't tell.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token: Option<TokenAmount>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenAmount {
    /// `asset`, `control`, `reservation`, `lp`, `receipt`, `position` or `order`.
    pub kind: String,
    /// Display order.
    pub id: String,
    /// Base units, as a decimal string.
    pub amount: String,
}

/// An asset's facts, as the transaction that registered it states them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckedRegistration {
    /// Display order.
    pub asset: String,
    /// The registration's txid, display order.
    pub txid: String,
    pub ticker: String,
    /// The display name it set, or else the ticker.
    pub name: String,
    pub decimals: u8,
}

fn malformed(message: impl Into<String>) -> Refusal {
    refuse(RefusalCode::Malformed, message)
}

fn transaction(tx_hex: &str) -> Result<Transaction, Refusal> {
    deserialize_hex(tx_hex).map_err(|e| malformed(format!("Not a transaction: {e}")))
}

/// The transaction's marker, if it has one, refusing a transaction the node would refuse for it.
fn marker(tx: &Transaction) -> Result<Option<(usize, Marker)>, Refusal> {
    let mut markers = tx.output.iter().enumerate().filter(|(_, o)| bast::is_marker(o.script_pubkey.as_bytes()));
    let Some((index, output)) = markers.next() else { return Ok(None) };
    if markers.next().is_some() {
        return Err(malformed("The transaction has more than one BAST marker, which Flush refuses."));
    }
    if tx.is_coinbase() {
        return Err(malformed("A coinbase can't carry a BAST marker."));
    }
    let marker = bast::parse(output.script_pubkey.as_bytes()).map_err(|e| malformed(format!("Its BAST marker doesn't parse: {e}.")))?;
    let mut previous = None;
    for listed in &marker.outputs {
        let n = listed.n as usize;
        if previous.is_some_and(|p| n <= p) || n == index {
            return Err(malformed("Its marker lists outputs out of order, or itself."));
        }
        let output = tx.output.get(n).ok_or_else(|| malformed(format!("Its marker lists output {n}, which it doesn't have.")))?;
        if output.value.to_sat() != 0 {
            return Err(malformed(format!("Its marker lists output {n}, which isn't of value 0.")));
        }
        previous = Some(n);
    }
    Ok(Some((index, marker)))
}

pub fn output_tokens(tx_hex: &str) -> Result<OutputTokens, Refusal> {
    let tx = transaction(tx_hex)?;
    let outputs = match marker(&tx)? {
        None => vec![],
        Some((_, marker)) => marker
            .outputs
            .into_iter()
            .map(|listed| OutputToken {
                vout: listed.n,
                token: listed.token.map(|t| TokenAmount { kind: t.kind.name().into(), id: t.id, amount: t.amount.to_string() }),
            })
            .collect(),
    };
    Ok(OutputTokens { txid: tx.compute_txid().to_string(), outputs })
}

pub fn asset_registration(asset: &str, tx_hex: &str) -> Result<CheckedRegistration, Refusal> {
    let invalid = |message: String| refuse(RefusalCode::InvalidContract, message);
    let tx = transaction(tx_hex)?;
    let txid = tx.compute_txid().to_string();
    let (_, marker) = marker(&tx)?.ok_or_else(|| invalid(format!("Transaction {txid} registers no asset: it has no BAST marker.")))?;
    let reg = marker.registration().ok_or_else(|| invalid(format!("Transaction {txid} doesn't register an asset: it is a {}.", marker.name)))?;
    if reg.asset != asset.to_ascii_lowercase() {
        return Err(invalid(format!("Transaction {txid} registers asset {}, not {asset}.", reg.asset)));
    }
    let ticker = reg.ticker.ok_or_else(|| invalid(format!("Asset {asset}'s registration names no ticker, so the wallet can't check its name.")))?;
    if bast::asset_id(&ticker) != reg.asset {
        return Err(invalid(format!("The ticker {ticker} isn't asset {asset}'s: it hashes to {}.", bast::asset_id(&ticker))));
    }
    if reg.decimals > MAX_DECIMALS {
        return Err(invalid(format!("Asset {asset}'s registration has {} decimals; Flush allows at most {MAX_DECIMALS}.", reg.decimals)));
    }
    let name = reg.display_name.unwrap_or_else(|| ticker.clone());
    Ok(CheckedRegistration { asset: reg.asset, txid, ticker, name, decimals: reg.decimals })
}

