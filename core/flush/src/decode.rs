//! `decode(payload, starter)`: the Flush Decoder. A Clear View of a request it fully understands,
//! or `Blind { reason, verifiableFacts }`; never a partial Clear View.
//!
//! It understands payments of ECX, transfers of asset tokens to addresses (a `BAST` marker of
//! kind 0, docs/adr/0013), and trades (kind 21, `swap_pools`, docs/adr/0016) through one pool or a
//! route of them when the request's evidence describes each pool (`pool`, or a route's `pools`:
//! `getpool`'s answers), whose ids it recomputes: a trade's marker never names what comes out. Every other Flush operation (the rest of the DEX,
//! staking, withdrawals) is an `OP_RETURN` marker, and a request carrying one is Blind, naming the
//! operation when the tag is known. What a spent token output carries comes from the transaction holding it,
//! and the transfer's marker is left out of the outputs: its whole meaning is the tokens it lists. Whether an input or output is "yours" is decided
//! only by re-deriving it from the Starter, never by the requester; with no `bip32_derivation`,
//! only the receive address apps are given counts (docs/adr/0007). Every amount comes from the
//! previous transactions the PSBT carries, which `validated` checked against their txids.
use bitcoin::psbt::{Input, Output, Psbt};
use bitcoin::secp256k1::PublicKey;
use bitcoin::{EcdsaSighashType, TxOut};
use serde::Serialize;

use serde::Deserialize;

use crate::bast::{self, TokenKind};
use crate::link::MAX_ROUTE_POOLS;
use crate::trade::{pool_kind, PoolReport};
use crate::psbt::{operation, refuse, spent, validated, AssetAmount, OwnedInput, Refusal, RefusalCode};
use crate::result::ResultEvidence;
use crate::tokens::{token_flow_with, TokenFlow};
use crate::{address, AccountKeys};

/// What `decode` makes of a request it doesn't refuse.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Decoded {
    /// The module can't show what this request means; only the facts it can prove.
    #[serde(rename_all = "camelCase")]
    Blind { reason: String, verifiable_facts: VerifiableFacts },
    /// The Decoder fully understands the request: here is what it does.
    Clear { view: ClearView },
}

/// What the module proves about a request without understanding it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifiableFacts {
    /// Inputs that re-derive to the Starter (the only ones `sign` will sign).
    pub owned_inputs: Vec<OwnedInput>,
    /// Owned inputs minus outputs that re-derive to the Starter. Negative means more comes back.
    pub total_leaving: Vec<AssetAmount>,
    pub fee: Vec<AssetAmount>,
    /// Fields inside the PSBT the module doesn't know (preserved byte-for-byte when signing).
    pub unknown_fields: Vec<String>,
    /// Anything risky, to be shown above everything else.
    pub dangerous_flags: Vec<String>,
}

/// What the user is shown for a request the Decoder fully understands.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClearView {
    /// Always empty: a plain payment has no risky mode. Kept for the wallet's shared shape.
    pub dangerous_modes: Vec<DangerousMode>,
    pub inputs: Vec<ClearInput>,
    pub outputs: Vec<ClearOutput>,
    pub fee: AssetAmount,
    /// A trade's terms, for a request that trades (docs/adr/0016).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trade: Option<ClearTrade>,
}

/// A trade through its pools in turn, as its marker and the pools it names say.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClearTrade {
    /// Display hex, in turn: one, or a route's.
    pub pools: Vec<String>,
    /// "" for ECX, else an asset id.
    pub asset_in: String,
    /// Base units.
    pub amount_in: String,
    /// A route's assets between its pools, in turn ("" for ECX); empty for one pool.
    pub via: Vec<String>,
    /// The last pool's other side: "" for ECX, else an asset id.
    pub asset_out: String,
    /// The least it gives, base units: the floor the node enforces.
    pub min_out: String,
    /// The output that takes what comes out.
    pub result: usize,
    /// Where ECX paid out, or back if the trade doesn't fill, goes; None if ECX is on neither side.
    pub payout: Option<Destination>,
    /// What isn't the wallet's own, to show above everything else.
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClearInput {
    pub index: usize,
    /// "" for ECX, else the asset id of the token it spends.
    pub asset: String,
    /// Sats, or the asset's base units, as a decimal string.
    pub amount: String,
    /// Re-derives to the Starter: `sign` signs it.
    pub yours: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClearOutput {
    pub index: usize,
    /// "" for ECX, else the asset id of the token it carries.
    pub asset: String,
    /// Sats, or the asset's base units, as a decimal string.
    pub amount: String,
    /// A trade's result: at least `amount`, as the node clears it.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub at_least: bool,
    pub destination: Destination,
}

/// The evidence kinds the Flush Decoder checks; any other key is ignored.
#[derive(Debug, Default, Deserialize)]
struct Evidence {
    /// The pool a trade names, as `getpool` describes it.
    pool: Option<PoolReport>,
    /// A route's pools, in its order, as `getpool` describes each.
    pools: Option<Vec<PoolReport>>,
    /// The trade results it spends, as the market index names what each carries (docs/adr/0013).
    results: Option<Vec<ResultEvidence>>,
}

/// Where an output's funds go.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Destination {
    /// A Flush address; `yours` only if it re-derives to the Starter.
    Address { address: String, yours: bool },
}

/// A risky mode of a request. The Decoder explains none yet: what has one is Blind.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub enum DangerousMode {}

/// What an input is, decided by re-deriving it.
pub(crate) enum InputKind {
    Yours { chain: u32, index: u32, pubkey: PublicKey },
    /// Names the Starter's fingerprint, but doesn't re-derive: never signed.
    UnprovenClaim,
    Foreign,
}

pub(crate) fn classify_input(keys: &AccountKeys, input: &Input, spent: &TxOut) -> InputKind {
    let script = &spent.script_pubkey;
    let yours = |(chain, index): (u32, u32)| keys.public_key(chain, index).ok().map(|pubkey| InputKind::Yours { chain, index, pubkey });
    if input.bip32_derivation.is_empty() {
        return keys.given_out(script).and_then(yours).unwrap_or(InputKind::Foreign);
    }
    if let Some(owned) = input.bip32_derivation.iter().find_map(|(pubkey, source)| keys.owns(pubkey, source, script)) {
        return yours(owned).unwrap_or(InputKind::Foreign);
    }
    if input.bip32_derivation.values().any(|source| keys.claims(source)) {
        return InputKind::UnprovenClaim;
    }
    InputKind::Foreign
}

pub(crate) fn output_yours(keys: &AccountKeys, output: &Output, txout: &TxOut) -> bool {
    if output.bip32_derivation.is_empty() {
        return keys.given_out(&txout.script_pubkey).is_some();
    }
    output.bip32_derivation.iter().any(|(pubkey, source)| keys.owns(pubkey, source, &txout.script_pubkey).is_some())
}

/// The kind of each input, refusing a request with none of the Starter's (docs/adr/0007).
pub(crate) fn classified(psbt: &Psbt, keys: &AccountKeys) -> Result<Vec<InputKind>, Refusal> {
    let kinds: Vec<_> = (0..psbt.inputs.len()).map(|i| classify_input(keys, &psbt.inputs[i], spent(psbt, i))).collect();
    if !kinds.iter().any(|kind| matches!(kind, InputKind::Yours { .. })) {
        return Err(refuse(RefusalCode::NothingToSign, "No input of this request is this wallet's, so it has nothing to sign."));
    }
    Ok(kinds)
}

pub fn decode(payload: &str, starter: &str) -> Result<Decoded, Refusal> {
    decode_with_evidence(payload, starter, "{}")
}

/// `decode`, with the request's `evidence` (JSON): what it says is checked against the payload, and
/// a request whose evidence doesn't check out is refused (docs/adr/0009).
pub fn decode_with_evidence(payload: &str, starter: &str, evidence: &str) -> Result<Decoded, Refusal> {
    let evidence: Evidence = serde_json::from_str(evidence).map_err(|e| refuse(RefusalCode::InvalidEvidence, format!("The request's evidence isn't an object of known kinds: {e}")))?;
    let psbt = validated(payload)?;
    let keys = AccountKeys::new(starter).map_err(|e| refuse(RefusalCode::InvalidStarter, e))?;
    let kinds = classified(&psbt, &keys)?;
    let flow = token_flow_with(&psbt, evidence.results.as_deref().unwrap_or_default())?;
    let inputs_total: u64 = (0..psbt.inputs.len()).map(|i| spent(&psbt, i).value.to_sat()).sum();
    let outputs_total: u64 = psbt.unsigned_tx.output.iter().map(|o| o.value.to_sat()).sum();
    let fee = inputs_total
        .checked_sub(outputs_total)
        .ok_or_else(|| refuse(RefusalCode::Malformed, "The outputs add up to more than the inputs."))?;

    let facts = verifiable_facts(&psbt, &keys, &kinds, fee);
    if !facts.unknown_fields.is_empty() {
        let reason = "The request contains fields the Flush Decoder doesn't understand.";
        return Ok(Decoded::Blind { reason: reason.into(), verifiable_facts: facts });
    }
    let mut trade = None;
    if let Some((index, marker)) = flow.marker.as_ref().filter(|(_, m)| m.kind != 0) {
        let name = marker.name.replace('_', " ");
        let described = match (&evidence.pool, &evidence.pools) {
            (Some(_), Some(_)) => return Err(refuse(RefusalCode::InvalidEvidence, "The request's evidence gives both a pool and pools.")),
            (Some(pool), None) => Some(std::slice::from_ref(pool)),
            (None, pools) => pools.as_deref(),
        };
        let reason = match (marker.kind, described) {
            (21, Some(pools)) => match trade_terms(&psbt, &keys, &flow, *index, marker, pools)? {
                Ok(terms) => {
                    trade = Some(terms);
                    None
                }
                Err(why) => Some(format!("The Flush Decoder can't fully explain this {name} (output {index}): {why}")),
            },
            (21, None) => Some(format!("The request is a Flush {name} (output {index}): the wallet can't tell what it gives out without the pool's description.")),
            _ => Some(format!("The request is a Flush {name} (output {index}), which this wallet can't show yet.")),
        };
        if let Some(reason) = reason {
            return Ok(Decoded::Blind { reason, verifiable_facts: facts });
        }
    }
    let other = |o: &bitcoin::TxOut| (!bast::is_marker(o.script_pubkey.as_bytes())).then(|| operation(&o.script_pubkey)).flatten();
    if let Some((index, op)) = psbt.unsigned_tx.output.iter().enumerate().find_map(|(i, o)| other(o).map(|op| (i, op))) {
        let reason = format!("The request is {op} on Flush (output {index}), which this wallet can't show yet.");
        return Ok(Decoded::Blind { reason, verifiable_facts: facts });
    }
    match clear_view(&psbt, &keys, &kinds, fee, &flow, trade.as_ref()) {
        Ok(view) => Ok(Decoded::Clear { view: ClearView { trade: trade.map(|t| t.view), ..view } }),
        Err(why) => Ok(Decoded::Blind { reason: format!("The Flush Decoder can't fully explain this request: {why}"), verifiable_facts: facts }),
    }
}

fn verifiable_facts(psbt: &Psbt, keys: &AccountKeys, kinds: &[InputKind], fee: u64) -> VerifiableFacts {
    let mut owned_inputs = vec![];
    let mut leaving: i128 = 0;
    let mut unknown_fields = vec![];
    let mut dangerous_flags = vec![];

    unknown_fields.extend(psbt.unknown.keys().map(|k| format!("global: unknown field type 0x{:02x}", k.type_value)));
    unknown_fields.extend(psbt.proprietary.keys().map(|k| format!("global: proprietary field {}", String::from_utf8_lossy(&k.prefix))));

    for (i, (kind, input)) in kinds.iter().zip(&psbt.inputs).enumerate() {
        let value = spent(psbt, i).value.to_sat();
        match kind {
            InputKind::Yours { .. } => {
                owned_inputs.push(OwnedInput { index: i, asset: String::new(), amount: value.to_string() });
                leaving += value as i128;
            }
            InputKind::UnprovenClaim => dangerous_flags.push(format!(
                "input {i} claims one of this wallet's keys, but its key or script doesn't re-derive; it will not be signed"
            )),
            InputKind::Foreign => {}
        }
        if input.sighash_type.is_some_and(|t| t.ecdsa_hash_ty() != Ok(EcdsaSighashType::All)) {
            dangerous_flags.push(format!("input {i} asks for a non-default sighash"));
        }
        unknown_fields.extend(input.unknown.keys().map(|k| format!("input {i}: unknown field type 0x{:02x}", k.type_value)));
        unknown_fields.extend(input.proprietary.keys().map(|k| format!("input {i}: proprietary field {}", String::from_utf8_lossy(&k.prefix))));
    }

    for (i, (txout, output)) in psbt.unsigned_tx.output.iter().zip(&psbt.outputs).enumerate() {
        if output_yours(keys, output, txout) {
            leaving -= txout.value.to_sat() as i128;
        }
        unknown_fields.extend(output.unknown.keys().map(|k| format!("output {i}: unknown field type 0x{:02x}", k.type_value)));
        unknown_fields.extend(output.proprietary.keys().map(|k| format!("output {i}: proprietary field {}", String::from_utf8_lossy(&k.prefix))));
    }

    VerifiableFacts {
        owned_inputs,
        total_leaving: vec![AssetAmount::sats(leaving)],
        fee: vec![AssetAmount::sats(fee)],
        unknown_fields,
        dangerous_flags,
    }
}

/// The Clear View of `psbt` (already validated), or why the Decoder can't give one.
fn clear_view(psbt: &Psbt, keys: &AccountKeys, kinds: &[InputKind], fee: u64, flow: &TokenFlow, trade: Option<&Trade>) -> Result<ClearView, String> {
    if psbt.version != 0 || !psbt.xpub.is_empty() {
        return Err("it has global fields the Decoder doesn't explain.".into());
    }

    let mut inputs = vec![];
    for (index, (kind, input)) in kinds.iter().zip(&psbt.inputs).enumerate() {
        if input.sighash_type.is_some_and(|t| t.ecdsa_hash_ty() != Ok(EcdsaSighashType::All)) {
            return Err(format!("input {index} asks for a sighash other than ALL."));
        }
        if matches!(kind, InputKind::UnprovenClaim) {
            return Err(format!("input {index} claims one of this wallet's keys, but it doesn't re-derive."));
        }
        if !only_explained_input_fields(input) {
            return Err(format!("input {index} has fields the Decoder doesn't explain."));
        }
        let yours = matches!(kind, InputKind::Yours { .. });
        let (asset, amount) = match &flow.inputs[index] {
            None => (String::new(), spent(psbt, index).value.to_sat()),
            Some(listed) => asset_token(listed).map_err(|what| format!("input {index} spends {what}."))?,
        };
        inputs.push(ClearInput { index, asset, amount: amount.to_string(), yours });
    }

    let mut outputs = vec![];
    let marker = flow.marker.as_ref().map(|(index, _)| *index);
    for (index, (txout, output)) in psbt.unsigned_tx.output.iter().zip(&psbt.outputs).enumerate() {
        if !only_explained_output_fields(output) {
            return Err(format!("output {index} has fields the Decoder doesn't explain."));
        }
        if marker == Some(index) {
            // A transfer's marker (0 sat): what it says is each listed output's token. A trade's: its
            // terms, with the ECX it pays in.
            continue;
        }
        if txout.script_pubkey.is_op_return() {
            return Err(format!("output {index} is an OP_RETURN, which a plain payment doesn't have."));
        }
        let address = address(&txout.script_pubkey).ok_or_else(|| format!("output {index} pays a script that isn't an address."))?;
        let destination = Destination::Address { address, yours: output_yours(keys, output, txout) };
        if let Some(trade) = trade.filter(|t| t.view.result == index) {
            outputs.push(ClearOutput { index, asset: trade.view.asset_out.clone(), amount: trade.view.min_out.clone(), at_least: true, destination });
            continue;
        }
        let (asset, amount) = match flow.output(index) {
            None => (String::new(), txout.value.to_sat()),
            Some(listed) => asset_token(listed).map_err(|what| format!("output {index} carries {what}."))?,
        };
        outputs.push(ClearOutput { index, asset, amount: amount.to_string(), at_least: false, destination });
    }
    Ok(ClearView { dangerous_modes: vec![], inputs, outputs, fee: AssetAmount::sats(fee), trade: None })
}

/// A listed output's asset token as (id, amount), or what else it carries, for the Blind reason.
fn asset_token(listed: &bast::Listed) -> Result<(String, u64), String> {
    match &listed.token {
        Some(t) if t.kind == TokenKind::Asset => Ok((t.id.clone(), t.amount)),
        Some(t) => Err(format!("a {} token, which the Decoder doesn't show yet", t.kind.name())),
        None => Err("a result, whose token only the node's state knows".into()),
    }
}

/// True if `input` sets nothing beyond what a Clear View shows or `sign` needs. Unknown and
/// proprietary fields are reported (and make the request Blind) before this.
fn only_explained_input_fields(input: &Input) -> bool {
    let rest = Input {
        non_witness_utxo: None,
        witness_utxo: None,
        bip32_derivation: Default::default(),
        partial_sigs: Default::default(),
        sighash_type: None,
        proprietary: Default::default(),
        unknown: Default::default(),
        ..input.clone()
    };
    rest == Input::default()
}

/// True if `output` sets nothing beyond its derivation.
fn only_explained_output_fields(output: &Output) -> bool {
    let rest = Output { bip32_derivation: Default::default(), proprietary: Default::default(), unknown: Default::default(), ..output.clone() };
    rest == Output::default()
}

/// A trade's terms, checked against its pool's description.
struct Trade {
    view: ClearTrade,
}

/// The terms of the trade `marker` (kind 21, output `index`) through `described`, each pool it
/// names in turn: refused if a pool described isn't the one it names or doesn't take what comes to
/// it (the evidence doesn't check out), `Err` with why it can't be Clear if it does more than
/// trade, or than the Decoder can check.
fn trade_terms(psbt: &Psbt, keys: &AccountKeys, flow: &TokenFlow, index: usize, marker: &bast::Marker, described: &[PoolReport]) -> Result<Result<Trade, String>, Refusal> {
    let bad_evidence = |message: String| refuse(RefusalCode::InvalidEvidence, message);
    let f = &marker.fields;
    let text = |key: &str| f.get(key).and_then(|v| v.as_str()).unwrap_or_default().to_string();
    let number = |key: &str| f.get(key).and_then(|v| v.as_u64()).unwrap_or_default();
    let pools: Vec<&str> = f.get("pools").and_then(|v| v.as_array()).map(|a| a.iter().filter_map(|p| p.as_str()).collect()).unwrap_or_default();
    if pools.is_empty() || pools.len() > MAX_ROUTE_POOLS {
        return Ok(Err(format!("it trades through {} pools; a trade goes through 1 to {MAX_ROUTE_POOLS}.", pools.len())));
    }
    if described.len() != pools.len() {
        return Err(bad_evidence(format!("The trade goes through {} pools, and the evidence describes {}.", pools.len(), described.len())));
    }
    let asset_in = text("asset_in");
    // The path: from what it pays in through each pool to its other side. Walked here apart from
    // the builder's walk (trade.rs) on purpose: the Decoder checks what was built, so one bug can't pass both.
    let mut path = vec![asset_in.clone()];
    for (pool, &named) in described.iter().zip(&pools) {
        let (a, b) = (pool.asset_a_id.to_ascii_lowercase(), pool.asset_b_id.to_ascii_lowercase());
        let kind = pool_kind(pool)?;
        let id = bast::pool_id(&a, &b, &kind).map_err(|e| bad_evidence(format!("The pool's description: {e}")))?;
        if id != named {
            return Err(bad_evidence(format!("The pool described is {id}, not the {named} the trade names.")));
        }
        let at = path.last().expect("the path starts at asset_in");
        let next = if a == *at { b } else if b == *at { a } else {
            return Err(bad_evidence(format!("Pool {named} doesn't hold asset {at}, which comes to it.")));
        };
        if path.contains(&next) {
            return Ok(Err(format!("its route comes back to asset {next}.")));
        }
        path.push(next);
    }
    let asset_out = path.last().expect("one pool at least").clone();
    let ecx = |id: &str| id.bytes().all(|c| c == b'0');
    let (amount_in, min_out) = (number("amount_in"), number("min_out"));

    // The ECX paid in is what the marker holds; a token paid in comes from the inputs.
    let held = psbt.unsigned_tx.output[index].value.to_sat();
    let paid_ecx = if ecx(&asset_in) { amount_in } else { 0 };
    if held != paid_ecx {
        return Ok(Err(format!("its marker holds {held} sat of ECX, not the {paid_ecx} it pays in.")));
    }
    // Listed: change of the token paid in, and one result.
    let results: Vec<usize> = marker.outputs.iter().filter(|o| o.token.is_none()).map(|o| o.n as usize).collect();
    let [result] = results[..] else {
        return Ok(Err(format!("it lists {} results; a trade has one.", results.len())));
    };
    let mut change = 0u128;
    for listed in &marker.outputs {
        match &listed.token {
            None => {}
            Some(t) if t.kind == TokenKind::Asset && t.id == asset_in => change += t.amount as u128,
            Some(t) => return Ok(Err(format!("output {} carries a {} token the trade doesn't pay in.", listed.n, t.kind.name()))),
        }
    }
    let mut spent = 0u128;
    for (i, listed) in flow.inputs.iter().enumerate() {
        match listed.as_ref().map(|l| &l.token) {
            None => {}
            Some(Some(t)) if t.kind == TokenKind::Asset && t.id == asset_in => spent += t.amount as u128,
            Some(_) => return Ok(Err(format!("input {i} spends a token the trade doesn't pay in."))),
        }
    }
    let paid_tokens = if ecx(&asset_in) { 0 } else { amount_in as u128 };
    if spent != change + paid_tokens {
        return Ok(Err("the tokens it spends aren't exactly what it pays in plus its change.".into()));
    }
    let Some(result_out) = psbt.unsigned_tx.output.get(result) else {
        return Ok(Err(format!("its result is output {result}, which the transaction doesn't have.")));
    };

    let mut warnings = vec![];
    if !output_yours(keys, &psbt.outputs[result], result_out) {
        warnings.push(format!("What the trade gives (output {result}) goes to someone else's address."));
    }
    for listed in marker.outputs.iter().filter(|o| o.token.is_some()) {
        let n = listed.n as usize;
        if psbt.unsigned_tx.output.get(n).is_some_and(|out| !output_yours(keys, &psbt.outputs[n], out)) {
            warnings.push(format!("The change of what it pays in (output {n}) goes to someone else's address."));
        }
    }
    let chn_to = text("chn_to");
    let payout = if chn_to.is_empty() {
        None
    } else {
        let script = bitcoin::ScriptBuf::from_hex(&chn_to).map_err(|_| refuse(RefusalCode::Malformed, "The trade's chn_to isn't a script."))?;
        let Some(address) = address(&script) else {
            return Ok(Err("it pays ECX out to a script that isn't an address.".into()));
        };
        let yours = keys.given_out(&script).is_some();
        if !yours {
            warnings.push("ECX it pays out, or back if it doesn't fill, goes to someone else's address.".into());
        }
        Some(Destination::Address { address, yours })
    };
    let id = |asset: &str| if ecx(asset) { String::new() } else { asset.to_string() };
    Ok(Ok(Trade {
        view: ClearTrade {
            pools: pools.iter().map(|p| p.to_string()).collect(),
            asset_in: id(&asset_in),
            amount_in: amount_in.to_string(),
            via: path[1..path.len() - 1].iter().map(|a| id(a)).collect(),
            asset_out: id(&asset_out),
            min_out: min_out.to_string(),
            result,
            payout,
            warnings,
        },
    }))
}
