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
//! - [`asset_logo`]: an asset's logo, from the transaction that set it, which carries the image.
use bitcoin::consensus::encode::deserialize_hex;
use bitcoin::Transaction;
use serde::Serialize;

use crate::bast::{self, Marker};
use crate::psbt::{refuse, Refusal, RefusalCode};
use crate::result::{result_token, ResultEvidence};

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
    /// A trade through pools (kind 21, `swap_pools`): its order, by which the wallet finds its outcome
    /// and pairs its payout (docs/adr/0017).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub swap: Option<SwapOrder>,
}

/// A kind-21 order as its marker states it. What comes out is the pool's other asset.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SwapOrder {
    /// Display order.
    pub asset_in: String,
    /// Display order, in the order traded through.
    pub pools: Vec<String>,
    /// Base units, as decimal strings.
    pub amount_in: String,
    pub min_out: String,
    /// The script ECX is paid out or back to (hex; empty when ECX is on neither side).
    pub chn_to: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputToken {
    pub vout: u32,
    /// The script it pays, hex: whoever counts the token checks it is theirs.
    pub script: String,
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

/// What output `vout` of `tx` carries: Ok(None) for an output no marker lists (a coin, or a
/// block's empty fee output), `Listed::token` None for a result.
pub(crate) fn listed_on(tx: &Transaction, vout: u32) -> Result<Option<bast::Listed>, Refusal> {
    Ok(marker(tx)?.and_then(|(_, m)| m.outputs.into_iter().find(|o| o.n == vout)))
}

/// The transaction's marker, if it has one, refusing a transaction the node would refuse for it.
pub(crate) fn marker(tx: &Transaction) -> Result<Option<(usize, Marker)>, Refusal> {
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
        // Flush Core's `Spendable`, else `bad-ba-token-output`.
        let script = &output.script_pubkey;
        if !(script.is_p2pkh() || script.is_p2sh() || script.is_p2wpkh() || script.is_p2wsh() || script.is_p2tr()) {
            return Err(malformed(format!("Its marker lists output {n}, whose script the node can't hold a token on.")));
        }
        previous = Some(n);
    }
    Ok(Some((index, marker)))
}

pub fn output_tokens(tx_hex: &str) -> Result<OutputTokens, Refusal> {
    let tx = transaction(tx_hex)?;
    let Some((_, marker)) = marker(&tx)? else {
        return Ok(OutputTokens { txid: tx.compute_txid().to_string(), outputs: vec![], swap: None });
    };
    let swap = swap_order(&marker);
    let outputs = marker
        .outputs
        .into_iter()
        .map(|listed| OutputToken {
            vout: listed.n,
            script: crate::hex(tx.output[listed.n as usize].script_pubkey.as_bytes()),
            token: listed.token.map(|t| TokenAmount { kind: t.kind.name().into(), id: t.id, amount: t.amount.to_string() }),
        })
        .collect();
    Ok(OutputTokens { txid: tx.compute_txid().to_string(), outputs, swap })
}

/// A kind-21 marker's order; None for any other marker.
fn swap_order(marker: &Marker) -> Option<SwapOrder> {
    if marker.kind != 21 {
        return None;
    }
    let f = &marker.fields;
    let text = |key: &str| f.get(key).and_then(|v| v.as_str()).map(str::to_string);
    let number = |key: &str| f.get(key).and_then(|v| v.as_u64()).map(|n| n.to_string());
    let pools = f.get("pools")?.as_array()?.iter().map(|p| p.as_str().map(str::to_string)).collect::<Option<Vec<_>>>()?;
    Some(SwapOrder { asset_in: text("asset_in")?, pools, amount_in: number("amount_in")?, min_out: number("min_out")?, chn_to: text("chn_to")? })
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

/// The tokens a request moves: its marker, and what each input carries, as the transactions it
/// spends (each checked against its txid by `validated`) list them.
pub(crate) struct TokenFlow {
    /// The marker, and its output's index.
    pub marker: Option<(usize, Marker)>,
    /// Per input: the token its spent output carries (`Listed::token` None for a result), or None
    /// for an output no marker lists.
    pub inputs: Vec<Option<bast::Listed>>,
}

impl TokenFlow {
    /// The token output `n` of the request carries, if its marker lists it.
    pub fn output(&self, n: usize) -> Option<&bast::Listed> {
        self.marker.as_ref()?.1.outputs.iter().find(|o| o.n as usize == n)
    }
}

/// What `psbt` (already `validated`) does with tokens, refusing what Flush would refuse: spending a
/// token output without a marker (`bad-ba-tokens-lost`), and a transfer (kind 0) whose marker holds
/// value (`bad-ba-marker-value`), lists a result (`bad-ba-results`) or doesn't carry on exactly the
/// tokens its inputs bring (`bad-ba-tokens-lost`, `bad-ba-tokens-unbacked`). A transfer that spends a
/// result can't be checked here: the Decoder shows it Blind, unless `token_flow_with` is told what
/// the result carries.
pub(crate) fn token_flow(psbt: &bitcoin::psbt::Psbt) -> Result<TokenFlow, Refusal> {
    token_flow_with(psbt, &[])
}

/// `token_flow`, with what the market index says of the trade results it spends (`results`, the
/// request's evidence), each checked against its order (`result_token`) before it counts.
pub(crate) fn token_flow_with(psbt: &bitcoin::psbt::Psbt, results: &[ResultEvidence]) -> Result<TokenFlow, Refusal> {
    let tx = &psbt.unsigned_tx;
    let marker = marker(tx)?;
    let mut inputs = vec![];
    for (i, txin) in tx.input.iter().enumerate() {
        let previous = psbt.inputs[i].non_witness_utxo.as_ref().expect("validated");
        let outpoint = txin.previous_output;
        let mut listed = listed_on(previous, outpoint.vout)?;
        let said = results.iter().find(|r| r.vout == outpoint.vout && r.txid.eq_ignore_ascii_case(&outpoint.txid.to_string()));
        if let (Some(l @ bast::Listed { token: None, .. }), Some(said)) = (listed.as_mut(), said) {
            let token = result_token(previous, outpoint.vout, &said.claim())?
                .map_err(|why| refuse(RefusalCode::InvalidEvidence, format!("Input {i} is a trade's result, but the evidence doesn't fit it: {why}.")))?;
            l.token = Some(token);
        }
        inputs.push(listed);
    }
    let flow = TokenFlow { marker, inputs };
    let Some((index, marker)) = &flow.marker else {
        if let Some(i) = flow.inputs.iter().position(Option::is_some) {
            return Err(malformed(format!("Input {i} spends a token's output, but the request has no BAST marker to carry it on: Flush would refuse it.")));
        }
        return Ok(flow);
    };
    if marker.kind != 0 {
        return Ok(flow);
    }
    if tx.output[*index].value.to_sat() != 0 {
        return Err(malformed("The transfer's BAST marker holds ECX, which Flush refuses for a transfer."));
    }
    if marker.outputs.iter().any(|o| o.token.is_none()) {
        return Err(malformed("The transfer's BAST marker lists a result, which Flush refuses for a transfer."));
    }
    let tokens = |listed: &mut dyn Iterator<Item = &bast::Listed>| -> Option<std::collections::BTreeMap<(bast::TokenKind, String), u128>> {
        let mut totals = std::collections::BTreeMap::new();
        for l in listed {
            let t = l.token.as_ref()?;
            *totals.entry((t.kind, t.id.clone())).or_insert(0u128) += t.amount as u128;
        }
        Some(totals)
    };
    let Some(spent) = tokens(&mut flow.inputs.iter().flatten()) else { return Ok(flow) };
    let carried = tokens(&mut marker.outputs.iter()).expect("no result listed");
    if spent != carried {
        return Err(malformed("The transfer doesn't carry on exactly the tokens its inputs spend: Flush would refuse it."));
    }
    Ok(flow)
}

/// The most bytes a logo the wallet shows may have. Flush's own cap is the marker's size.
pub const MAX_LOGO_BYTES: usize = 100_000;

/// An asset's logo, as the transaction that set it carries it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckedLogo {
    /// Display order.
    pub asset: String,
    /// The transaction that set it, display order.
    pub txid: String,
    /// `image/png`, `image/jpeg`, `image/gif` or `image/webp`, from the bytes themselves.
    pub mime: String,
    /// The image, hex.
    pub bytes: String,
}

/// The image type `bytes` start with, if the wallet shows it: raster formats only, never SVG.
fn image_type(bytes: &[u8]) -> Option<&'static str> {
    match bytes {
        [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, ..] => Some("image/png"),
        [0xFF, 0xD8, 0xFF, ..] => Some("image/jpeg"),
        [b'G', b'I', b'F', b'8', b'7' | b'9', b'a', ..] => Some("image/gif"),
        [b'R', b'I', b'F', b'F', _, _, _, _, b'W', b'E', b'B', b'P', ..] => Some("image/webp"),
        _ => None,
    }
}

/// `asset`'s logo, only if `tx` sets one for that very id: a SetLogo (kind 32) for it, or its
/// registration with a logo. Consensus lets only the asset's control coin set it.
pub fn asset_logo(asset: &str, tx_hex: &str) -> Result<CheckedLogo, Refusal> {
    let invalid = |message: String| refuse(RefusalCode::InvalidContract, message);
    let tx = transaction(tx_hex)?;
    let txid = tx.compute_txid().to_string();
    let (_, marker) = marker(&tx)?.ok_or_else(|| invalid(format!("Transaction {txid} sets no logo: it has no BAST marker.")))?;
    let set_for = match marker.kind {
        32 => marker.fields.get("asset").and_then(|a| a.as_str()).map(str::to_owned),
        _ => marker.registration().map(|r| r.asset),
    };
    let asset = asset.to_ascii_lowercase();
    let (Some(for_asset), Some(bytes)) = (set_for, marker.logo) else {
        return Err(invalid(format!("Transaction {txid} sets no logo: it is a {}.", marker.name)));
    };
    if for_asset != asset {
        return Err(invalid(format!("Transaction {txid} sets asset {for_asset}'s logo, not {asset}'s.")));
    }
    if bytes.len() > MAX_LOGO_BYTES {
        return Err(invalid(format!("Asset {asset}'s logo is {} bytes; the wallet shows at most {MAX_LOGO_BYTES}.", bytes.len())));
    }
    let mime = image_type(&bytes).ok_or_else(|| invalid(format!("Asset {asset}'s logo isn't a PNG, JPEG, GIF or WebP image.")))?;
    Ok(CheckedLogo { asset, txid, mime: mime.into(), bytes: crate::hex(&bytes) })
}
