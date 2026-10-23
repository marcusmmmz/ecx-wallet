//! `asset_contract`: an asset's contract, checked against the chain (the `assetContract`
//! capability, docs/adr/0010). The asset id is derived, as consensus derives it, from the outpoint
//! its issuance spent and the SHA-256 of the contract's exact bytes, so a server that names the
//! outpoint can't make another contract pass: it would need a second preimage. The contract must
//! also follow the registry's rules, as evidence does (`evidence.rs`).
use std::str::FromStr;

use elements_miniscript::elements::hashes::{sha256, Hash};
use elements_miniscript::elements::{AssetId, ContractHash, OutPoint, Txid};
use serde::Serialize;

use crate::decode::{refuse, Refusal, RefusalCode};
use crate::evidence::{registry_fields, RegistryFields};

/// A contract that is the one `asset` was issued with, and follows the registry's rules. The issuer
/// chose its fields, and the domain isn't checked.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckedContract {
    /// Display hex.
    pub asset: String,
    pub name: String,
    pub ticker: String,
    /// Decimal places the issuer asks wallets to show.
    pub precision: u8,
    /// What the contract claims; this wallet doesn't check it.
    pub domain: String,
}

fn invalid(message: impl Into<String>) -> Refusal {
    refuse(RefusalCode::InvalidContract, message)
}

/// `contract`, if `asset` (display hex) is the asset a new issuance spending `txid:vout` (the
/// outpoint, display hex) and committing to `contract`'s bytes creates.
pub fn asset_contract(asset: &str, txid: &str, vout: u32, contract: &str) -> Result<CheckedContract, Refusal> {
    let asset = AssetId::from_str(asset).map_err(|e| invalid(format!("The asset id isn't one: {e}")))?;
    let txid = Txid::from_str(txid).map_err(|e| invalid(format!("The issuance's outpoint isn't one: {e}")))?;
    let hash = ContractHash::from_byte_array(sha256::Hash::hash(contract.as_bytes()).to_byte_array());
    if AssetId::from_entropy(AssetId::generate_asset_entropy(OutPoint::new(txid, vout), hash)) != asset {
        return Err(invalid(format!("The contract isn't the one asset {asset} was issued with.")));
    }
    let RegistryFields { name, ticker, precision, domain, .. } = registry_fields(contract).map_err(|why| invalid(format!("The contract {why}")))?;
    Ok(CheckedContract { asset: asset.to_string(), name, ticker, precision, domain })
}
