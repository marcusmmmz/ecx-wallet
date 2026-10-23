//! A Signing Request's `evidence`: data the requester supplies that `decode` checks against the
//! payload before the Clear View shows anything from it (docs/adr/0009). Unlike `hints`, evidence
//! that doesn't check out refuses the request. Kinds this module doesn't know are ignored.
//!
//! `assetContract`: `{ "<input index>": "<contract JSON>" }`, the contract behind a new issuance.
//! Its bytes must hash (one SHA-256) to the input's committed contract hash, and it must follow the
//! Liquid asset registry's rules, which also keep its name and ticker from spoofing the approval.
use std::collections::BTreeMap;
use std::str::FromStr;

use elements_miniscript::bitcoin::PublicKey;
use elements_miniscript::elements::hashes::{sha256, Hash};
use elements_miniscript::elements::pset::PartiallySignedTransaction;
use serde::Deserialize;
use serde_json::Value;

use crate::clear::{is_new_issuance, ClearContract};
use crate::decode::{refuse, Refusal, RefusalCode};
use crate::ownership::Wallet;

/// The kinds of evidence this module checks; any other key is ignored.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
pub struct Evidence {
    #[serde(default, rename = "assetContract")]
    asset_contract: BTreeMap<String, String>,
}

impl Evidence {
    /// The envelope's `evidence` object, as JSON.
    pub fn from_json(json: &str) -> Result<Self, Refusal> {
        let not_kinds = |e: String| invalid(format!("The request's evidence isn't an object of known kinds: {e}"));
        // An object only: serde would also build the struct from an array.
        let value: Value = serde_json::from_str(json).map_err(|e| not_kinds(e.to_string()))?;
        if !value.is_object() {
            return Err(not_kinds("not an object".into()));
        }
        serde_json::from_value(value).map_err(|e| not_kinds(e.to_string()))
    }
}

fn invalid(message: impl Into<String>) -> Refusal {
    refuse(RefusalCode::InvalidEvidence, message)
}

/// Each `assetContract`, checked against the payload (refused if one doesn't check out): per input
/// index, the contract the Clear View may show.
pub(crate) fn checked_contracts(
    pset: &PartiallySignedTransaction,
    evidence: &Evidence,
    wallet: &Wallet,
) -> Result<BTreeMap<usize, ClearContract>, Refusal> {
    let mut checked = BTreeMap::new();
    for (key, contract) in &evidence.asset_contract {
        let input = usize::from_str(key)
            .ok()
            .and_then(|i| pset.inputs().get(i).map(|input| (i, input)))
            .filter(|(_, input)| is_new_issuance(input));
        let Some((i, input)) = input else {
            return Err(invalid(format!("The request has a contract for input {key}, which issues no new asset.")));
        };
        if sha256::Hash::hash(contract.as_bytes()).to_byte_array() != input.issuance_asset_entropy.unwrap_or_default() {
            return Err(invalid(format!("The contract for input {i} isn't the one its issuance commits to.")));
        }
        let shown = registry_contract(contract, wallet).map_err(|why| invalid(format!("The contract for input {i} {why}")))?;
        checked.insert(i, shown);
    }
    Ok(checked)
}

/// The fields the approval shows, if `contract` follows the Liquid asset registry's rules (as
/// `lwk_wollet::Contract::validate`): version 0, precision 0-8, a 1-255 character name, a 3-24
/// character ticker of letters, digits, dots and hyphens, a domain, and a compressed issuer key.
/// Stricter than the registry in one way: the name must be printable ASCII, no control characters.
fn registry_contract(contract: &str, wallet: &Wallet) -> Result<ClearContract, String> {
    let value: Value = serde_json::from_str(contract).map_err(|e| format!("isn't JSON: {e}"))?;
    let field = |name: &str| value.get(name).ok_or(format!("has no `{name}`."));
    let text = |name: &str| field(name)?.as_str().ok_or(format!("has a `{name}` that isn't a string."));

    if field("version")?.as_u64() != Some(0) {
        return Err("isn't version 0.".into());
    }
    let precision = field("precision")?.as_u64().filter(|p| *p <= 8).ok_or("has a precision that isn't 0 to 8.")?;
    let name = text("name")?;
    if !(1..=255).contains(&name.len()) || !name.bytes().all(|b| (0x20..=0x7e).contains(&b)) {
        return Err("has a name that isn't 1 to 255 printable ASCII characters.".into());
    }
    let ticker = text("ticker")?;
    if !(3..=24).contains(&ticker.len()) || !ticker.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-') {
        return Err("has a ticker that isn't 3 to 24 letters, digits, dots or hyphens.".into());
    }
    let domain = field("entity")?.get("domain").and_then(Value::as_str).ok_or("has no `entity.domain`.")?;
    if !is_domain(domain) {
        return Err("has an `entity.domain` that isn't a domain name.".into());
    }
    let issuer = PublicKey::from_str(text("issuer_pubkey")?)
        .ok()
        .filter(|pk| pk.compressed)
        .ok_or("has an `issuer_pubkey` that isn't a compressed public key in hex.")?;
    Ok(ClearContract {
        name: name.into(),
        ticker: ticker.into(),
        precision: precision as u8,
        domain: domain.into(),
        issuer_yours: wallet.gives_out(&issuer),
    })
}

/// A lowercase DNS name of at least two labels, each 1-63 letters, digits or inner hyphens.
fn is_domain(domain: &str) -> bool {
    let labels: Vec<_> = domain.split('.').collect();
    domain.len() <= 253
        && labels.len() >= 2
        && labels.iter().all(|l| {
            (1..=63).contains(&l.len())
                && l.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
                && !l.starts_with('-')
                && !l.ends_with('-')
        })
}
