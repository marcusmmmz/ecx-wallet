//! `decode(payload, starter)`: the request's refusals (spec "Signing Request", rules 5-7), then
//! either a Clear View or `Blind { reason, verifiableFacts }`.
//!
//! The Decoder itself is `clear.rs`. Whatever it can't fully explain (unknown fields included) is
//! Blind, never a partial Clear View. The verifiable facts are what the module can prove on its own: they never come from the
//! requester's hints.
use std::collections::BTreeMap;
use std::str::FromStr;

use elements_miniscript::elements::confidential::{Asset, Value};
use elements_miniscript::elements::hashes::Hash;
use elements_miniscript::elements::pset::raw::ProprietaryKey;
use elements_miniscript::elements::pset::{Input, Output, PartiallySignedTransaction};
use elements_miniscript::elements::BlockHash;
use serde::Serialize;

use crate::classify::{classify, Classified, OutputKind, Sighash};
use crate::clear::{clear_view, ClearView};
use crate::evidence::{checked_contracts, Evidence};
use crate::network;
use crate::ownership::Wallet;

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
    /// Inputs that re-derive to this Starter's keys (the only ones `sign` will sign).
    pub owned_inputs: Vec<OwnedInput>,
    /// Per asset: owned inputs minus outputs that re-derive to this Starter. Negative means more
    /// comes back than goes in, as with an asset issued to the wallet; the approval window shows
    /// those amounts as coming into the wallet.
    pub total_leaving: Vec<AssetAmount>,
    /// Per asset, the fee outputs (empty script).
    pub fee: Vec<AssetAmount>,
    /// Fields inside the PSET the module doesn't know (preserved byte-for-byte when signing).
    pub unknown_fields: Vec<String>,
    /// Anything risky, to be shown above everything else.
    pub dangerous_flags: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OwnedInput {
    pub index: usize,
    /// Display hex.
    pub asset: String,
    /// Base units, as a decimal string.
    pub amount: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetAmount {
    /// Display hex.
    pub asset: String,
    /// Base units, as a decimal string.
    pub amount: String,
}

/// Why the module won't decode or sign a request.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Refusal {
    pub code: RefusalCode,
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RefusalCode {
    /// Not a PSET (or not one this module can read).
    Malformed,
    /// The ELIP-101 genesis is missing or isn't this network's (rule 5).
    WrongGenesis,
    /// A confidential input or output: v0 is explicit-only (rule 6).
    Confidential,
    /// An input without `witness_utxo`, or without `bip32_derivation` and not spending an address
    /// the wallet gives apps (rule 7).
    MissingInputFields,
    /// No input in the PSET is this Starter's: signing would change nothing.
    NothingToSign,
    /// The request's `evidence` doesn't check out against the payload (docs/adr/0009).
    InvalidEvidence,
    /// The Starter handed in isn't one (a wallet bug, not the requester's).
    InvalidStarter,
    /// `build_transfer`: the coins don't cover the amounts and the fee.
    InsufficientFunds,
    /// `build_transfer`: an amount, or change that can't go to the fee, is below what Elements relays.
    Dust,
}

pub(crate) fn refuse(code: RefusalCode, message: impl Into<String>) -> Refusal {
    Refusal { code, message: message.into() }
}

/// ELIP-101's global proprietary key for the genesis hash.
fn genesis_key() -> ProprietaryKey {
    ProprietaryKey::from_pset_pair(0x02, vec![])
}

/// Parses `payload` and applies rules 5-7, in order, as far as they need no Starter: the rest of
/// rule 7 is [`ownership_rules`]. `sign` runs the same checks.
pub(crate) fn validated(payload: &str) -> Result<PartiallySignedTransaction, Refusal> {
    let pset = PartiallySignedTransaction::from_str(payload)
        .map_err(|e| refuse(RefusalCode::Malformed, format!("The payload is not a PSET: {e}")))?;

    // 5. ELIP-101 genesis.
    let expected = BlockHash::from_str(&network().params.genesis_hash).expect("Chain Entry genesis is valid");
    match pset.global.proprietary.get(&genesis_key()) {
        None => return Err(refuse(RefusalCode::WrongGenesis, "The PSET doesn't name its chain (no ELIP-101 genesis hash).")),
        Some(found) if found.as_slice() != expected.as_byte_array() => {
            return Err(refuse(RefusalCode::WrongGenesis, "The PSET is for another chain (its genesis hash isn't this network's)."))
        }
        Some(_) => {}
    }

    // 6. Explicit-only.
    if !pset.global.scalars.is_empty() {
        return Err(refuse(RefusalCode::Confidential, "The PSET carries blinding scalars; this wallet is explicit-only."));
    }
    if let Some(i) = pset.inputs().iter().position(input_is_confidential) {
        return Err(refuse(RefusalCode::Confidential, format!("Input {i} is confidential; this wallet is explicit-only.")));
    }
    if let Some(i) = pset.outputs().iter().position(output_is_confidential) {
        return Err(refuse(RefusalCode::Confidential, format!("Output {i} is confidential; this wallet is explicit-only.")));
    }

    // 7. Every input says what it spends.
    if let Some(i) = pset.inputs().iter().position(|input| input.witness_utxo.is_none()) {
        return Err(refuse(RefusalCode::MissingInputFields, format!("Input {i} has no witness_utxo.")));
    }
    Ok(pset)
}

/// The rest of rule 7, which needs the Starter: every input says whose key it needs, unless it spends
/// an address the wallet gave apps. Then, at least one input must be this Starter's.
pub(crate) fn ownership_rules(pset: &PartiallySignedTransaction, wallet: &Wallet) -> Result<(), Refusal> {
    let mut owns_any = false;
    for (i, input) in pset.inputs().iter().enumerate() {
        let owned = wallet.owned_input_key(input).is_some();
        if input.bip32_derivation.is_empty() && !owned {
            return Err(refuse(RefusalCode::MissingInputFields, format!("Input {i} has no bip32_derivation.")));
        }
        owns_any |= owned;
    }
    if !owns_any {
        return Err(refuse(RefusalCode::NothingToSign, "No input in this PSET is this wallet's: there is nothing to sign."));
    }
    Ok(())
}

fn input_is_confidential(input: &Input) -> bool {
    let utxo_confidential = input
        .witness_utxo
        .as_ref()
        .is_some_and(|utxo| !matches!(utxo.asset, Asset::Explicit(_)) || !matches!(utxo.value, Value::Explicit(_)));
    utxo_confidential
        || input.blind_value_proof.is_some()
        || input.blind_asset_proof.is_some()
        || input.in_utxo_rangeproof.is_some()
        || input.issuance_value_comm.is_some()
        || input.issuance_inflation_keys_comm.is_some()
        || input.blinded_issuance.is_some()
}

fn output_is_confidential(output: &Output) -> bool {
    output.amount.is_none()
        || output.asset.is_none()
        || output.amount_comm.is_some()
        || output.asset_comm.is_some()
        || output.blinding_key.is_some()
        || output.ecdh_pubkey.is_some()
        || output.blinder_index.is_some()
        || output.value_rangeproof.is_some()
        || output.asset_surjection_proof.is_some()
        || output.blind_value_proof.is_some()
        || output.blind_asset_proof.is_some()
}

/// The refusals that need no Starter (rules 5, 6 and the first half of 7), so the wallet can refuse
/// before asking the user to unlock. `decode` and `sign` run them again.
pub fn check(payload: &str) -> Result<(), Refusal> {
    validated(payload).map(|_| ())
}

/// `evidence` is checked whether the request is Clear or Blind; only a Clear View shows it.
pub fn decode(payload: &str, starter: &str, evidence: &Evidence) -> Result<Decoded, Refusal> {
    let pset = validated(payload)?;
    let wallet = Wallet::new(starter).map_err(|e| refuse(RefusalCode::InvalidStarter, e))?;
    ownership_rules(&pset, &wallet)?;
    let contracts = checked_contracts(&pset, evidence, &wallet)?;
    let classified = classify(&pset, &wallet);
    let facts = verifiable_facts(&pset, &classified);
    if !facts.unknown_fields.is_empty() {
        let reason = "The request contains fields the Elements Decoder doesn't understand.";
        return Ok(Decoded::Blind { reason: reason.into(), verifiable_facts: facts });
    }
    match clear_view(&pset, &classified, &contracts) {
        Ok(view) => Ok(Decoded::Clear { view }),
        Err(why) => Ok(Decoded::Blind { reason: format!("The Elements Decoder can't fully explain this request: {why}"), verifiable_facts: facts }),
    }
}

fn verifiable_facts(pset: &PartiallySignedTransaction, classified: &Classified) -> VerifiableFacts {
    let mut owned_inputs = vec![];
    let mut leaving = BTreeMap::<String, i128>::new();
    let mut unknown_fields = vec![];
    let mut dangerous_flags = vec![];

    unknown_fields.extend(pset.global.unknown.keys().map(|k| format!("global: unknown field type 0x{:02x}", k.type_value)));
    unknown_fields.extend(
        pset.global.proprietary.keys().filter(|k| **k != genesis_key()).map(|k| format!("global: {}", proprietary(k))),
    );

    for (class, input) in classified.inputs.iter().zip(pset.inputs()) {
        let i = class.index;
        if class.yours {
            owned_inputs.push(OwnedInput { index: i, asset: class.asset.clone(), amount: class.amount.to_string() });
            *leaving.entry(class.asset.clone()).or_default() += class.amount as i128;
        } else if class.unproven_claim {
            dangerous_flags.push(format!(
                "input {i} claims one of this wallet's keys, but its key or script doesn't re-derive; it will not be signed"
            ));
        }
        if let Sighash::Known(sighash) | Sighash::Unknown(sighash) = class.sighash {
            dangerous_flags.push(format!("input {i} uses non-default sighash 0x{sighash:02x}"));
        }
        if input.issuance_value_amount.is_some() || input.issuance_inflation_keys.is_some() {
            dangerous_flags.push(format!("input {i} issues or reissues an asset"));
        }
        if input.pegin_tx.is_some() || input.pegin_witness.is_some() || input.pegin_claim_script.is_some() {
            dangerous_flags.push(format!("input {i} is a peg-in claim"));
        }
        unknown_fields.extend(input.unknown.keys().map(|k| format!("input {i}: unknown field type 0x{:02x}", k.type_value)));
        unknown_fields.extend(input.proprietary.keys().map(|k| format!("input {i}: {}", proprietary(k))));
    }

    for (class, output) in classified.outputs.iter().zip(pset.outputs()) {
        let i = class.index;
        match class.kind {
            OutputKind::Script { yours: true } => *leaving.entry(class.asset.clone()).or_default() -= class.amount as i128,
            OutputKind::WithdrawalBurn => dangerous_flags.push(format!("output {i} is a withdrawal burn: irreversible")),
            OutputKind::Fee | OutputKind::Script { yours: false } => {}
        }
        unknown_fields.extend(output.unknown.keys().map(|k| format!("output {i}: unknown field type 0x{:02x}", k.type_value)));
        unknown_fields.extend(output.proprietary.keys().map(|k| format!("output {i}: {}", proprietary(k))));
    }

    let amounts = |m: BTreeMap<String, i128>| m.into_iter().map(|(asset, amount)| AssetAmount { asset, amount: amount.to_string() }).collect();
    let fee = classified.fee.iter().map(|(asset, amount)| AssetAmount { asset: asset.clone(), amount: amount.to_string() }).collect();
    VerifiableFacts { owned_inputs, total_leaving: amounts(leaving), fee, unknown_fields, dangerous_flags }
}

fn proprietary(key: &ProprietaryKey) -> String {
    format!("proprietary field {}/{}", String::from_utf8_lossy(&key.prefix), key.subtype)
}
