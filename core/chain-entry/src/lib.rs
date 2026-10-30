//! The Chain Entry (docs/adr/0003): the description of one chain of the tree, eCash itself or a
//! sidechain, that ships compiled into that chain's module. The envelope is the same for every
//! chain; `params` is the module's own and only it reads them.
//!
//! On each network the root (eCash) has neither `slot` nor `parent`; every other chain has both: its
//! BIP300 Slot is its number under its parent there, which can differ by network (docs/adr/0019).
//!
//! The entry also says how the wallet shows the chain: its name, a line on what it's for, and on
//! each network the assets it names, one of which may be the chain's ECX (docs/adr/0005).
use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChainEntry<P> {
    /// The name the wallet shows for the chain ("Main chain", "Elements+").
    pub name: String,
    /// One line on what the chain is for, shown where the wallet lists its chains.
    pub description: String,
    pub networks: BTreeMap<String, NetworkEntry<P>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NetworkEntry<P> {
    /// CAIP-2 chain id: `ecash:<network>` for the root, `ecash:<network>-s<slot>` under it.
    pub chain: String,
    /// The chain's Slot under its parent on this network; absent for the root.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub slot: Option<u32>,
    /// The parent chain's `chain`; absent for the root.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent: Option<String>,
    /// The block a server must have to be on this chain: the identity check (docs/adr/0003).
    pub identity_block: IdentityBlock,
    /// The parent-chain block whose M2 activated this chain's Slot, pinned once checked. Only a
    /// chain with a parent has one. Without it, the wallet refuses a deposit while the Slot has no
    /// Treasury (docs/adr/0004).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub activation: Option<IdentityBlock>,
    /// Parent-chain confirmations before this chain's Slot credits a Deposit. Only a chain with a
    /// parent has one; without it, the wallet assumes BIP300's 100.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deposit_confirmations: Option<u32>,
    /// The default Sidechain Server and the Server API the wallet speaks to it.
    pub sidechain_server: SidechainServerEntry,
    /// Official App origins (placeholder).
    pub official_apps: Vec<String>,
    /// The assets the wallet names on this network; it shows any other as an unknown asset.
    pub assets: Vec<AssetEntry>,
    /// The module's own per-network values.
    pub params: P,
}

/// A block by height and hash (display hex). Height 0 (the genesis) unless the chain is a fork, whose
/// genesis is its ancestor's: then the first block after the fork.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IdentityBlock {
    pub height: u32,
    pub hash: String,
}

/// An asset the wallet shows by name.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssetEntry {
    /// The asset id, lowercase display hex as servers report it; empty for the chain's native coin,
    /// which its server reports without one (docs/adr/0005).
    pub id: String,
    pub ticker: String,
    pub name: String,
    /// Places after the point in one whole unit: an amount is reported in base units.
    pub decimals: u8,
    /// This network's ECX: what the wallet adds up across chains. At most one per network.
    #[serde(default, skip_serializing_if = "is_false")]
    pub ecx: bool,
}

fn is_false(value: &bool) -> bool {
    !value
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SidechainServerEntry {
    pub api: ServerApi,
    /// Base URL; the extension build grants itself access to its origin and nothing else.
    pub url: String,
}

/// The protocol the wallet speaks to a Sidechain Server (docs/adr/0002). No default.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ServerApi {
    /// The Standard Sidechain API (`stub-server/README.md`).
    #[serde(rename = "ecx-v0")]
    EcxV0,
    /// The Esplora REST API, the subset both electrs forks serve.
    #[serde(rename = "esplora")]
    Esplora,
    /// Flush's explorer: Esplora as mempool.space's electrs fork serves it, plus `/flush/blocks`,
    /// which says how final a block is (docs/adr/0012).
    #[serde(rename = "flush")]
    Flush,
}

impl<P> ChainEntry<P> {
    /// The rules one entry can check alone: each network's `slot` and `parent` are both present or
    /// both absent. That every `parent` exists is checked across entries, by the wallet's tests.
    pub fn check(&self) -> Result<(), String> {
        for (name, network) in &self.networks {
            if network.slot.is_some() != network.parent.is_some() {
                return Err(format!("{}'s {name}: a chain has both a slot and a parent, or neither", self.name));
            }
            if let Some(slot) = network.slot {
                if !network.chain.ends_with(&format!("-s{slot}")) {
                    return Err(format!("{}'s {name}: chain {} isn't Slot {slot}'s", self.name, network.chain));
                }
            }
            if !is_block_hash(&network.identity_block.hash) {
                return Err(format!("{}'s {name}: the identity block hash isn't 32 bytes of hex", self.name));
            }
            match &network.activation {
                Some(_) if network.parent.is_none() => {
                    return Err(format!("{}'s {name}: only a chain with a parent has an activation block", self.name))
                }
                Some(activation) if !is_block_hash(&activation.hash) => {
                    return Err(format!("{}'s {name}: the activation block hash isn't 32 bytes of hex", self.name))
                }
                _ => {}
            }
            match network.deposit_confirmations {
                Some(_) if network.parent.is_none() => {
                    return Err(format!("{}'s {name}: only a chain with a parent has deposit confirmations", self.name))
                }
                Some(0) => return Err(format!("{}'s {name}: deposit confirmations are at least 1", self.name)),
                _ => {}
            }
            self.check_assets(name, network)?;
        }
        Ok(())
    }

    fn check_assets(&self, name: &str, network: &NetworkEntry<P>) -> Result<(), String> {
        let chain = &self.name;
        for (i, asset) in network.assets.iter().enumerate() {
            let id = &asset.id;
            if !id.is_empty() && !is_lower_hex_32(id) {
                return Err(format!("{chain}'s {name}: asset {id} isn't 32 bytes of lowercase hex"));
            }
            if asset.ticker.trim().is_empty() || asset.name.trim().is_empty() {
                return Err(format!("{chain}'s {name}: asset {id:?} needs a ticker and a name"));
            }
            if network.assets[..i].iter().any(|a| a.id == *id) {
                return Err(format!("{chain}'s {name}: asset {id:?} is named twice"));
            }
        }
        if network.assets.iter().filter(|a| a.ecx).count() > 1 {
            return Err(format!("{chain}'s {name}: more than one asset is marked as ECX"));
        }
        Ok(())
    }
}

impl<P> NetworkEntry<P> {
    /// The network's ECX, if it names one.
    pub fn ecx_asset(&self) -> Option<&AssetEntry> {
        self.assets.iter().find(|a| a.ecx)
    }
}

fn is_block_hash(hash: &str) -> bool {
    hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_hexdigit())
}

fn is_lower_hex_32(id: &str) -> bool {
    id.len() == 64 && id.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(slot: Option<u32>, parent: Option<&str>) -> ChainEntry<()> {
        let network = NetworkEntry {
            chain: slot.map_or("ecash:betanet".into(), |slot| format!("ecash:betanet-s{slot}")),
            slot,
            parent: parent.map(Into::into),
            identity_block: IdentityBlock { height: 0, hash: "00".repeat(32) },
            activation: None,
            deposit_confirmations: None,
            sidechain_server: SidechainServerEntry { api: ServerApi::Esplora, url: "https://example.invalid".into() },
            official_apps: vec![],
            assets: vec![],
            params: (),
        };
        ChainEntry { name: "Test".into(), description: "A test chain".into(), networks: [("betanet".into(), network)].into() }
    }

    fn asset(id: &str, ecx: bool) -> AssetEntry {
        AssetEntry { id: id.into(), ticker: "ECX".into(), name: "eCash".into(), decimals: 8, ecx }
    }

    fn with_assets(mut entry: ChainEntry<()>, assets: Vec<AssetEntry>) -> ChainEntry<()> {
        entry.networks.get_mut("betanet").unwrap().assets = assets;
        entry
    }

    #[test]
    fn a_named_asset_is_an_asset_id_or_the_chains_native_coin() {
        let child = || entry(Some(46), Some("ecash:betanet"));
        assert!(with_assets(child(), vec![asset(&"5a".repeat(32), true)]).check().is_ok());
        assert!(with_assets(entry(None, None), vec![asset("", true)]).check().is_ok());
        assert!(with_assets(child(), vec![asset("", true)]).check().is_ok(), "a child chain's own coin has no asset id either");
        assert!(with_assets(child(), vec![asset("", true), asset("", false)]).check().is_err(), "a chain has one native coin");
        assert!(with_assets(child(), vec![asset("5a", false)]).check().is_err());
        assert!(with_assets(child(), vec![asset(&"5A".repeat(32), false)]).check().is_err(), "lowercase hex, as servers report it");
    }

    #[test]
    fn a_network_names_each_asset_once_and_has_at_most_one_ecx() {
        let child = || entry(Some(24), Some("ecash:betanet"));
        let (a, b) = ("5a".repeat(32), "6b".repeat(32));
        assert!(with_assets(child(), vec![asset(&a, true), asset(&b, false)]).check().is_ok());
        assert!(with_assets(child(), vec![asset(&a, false), asset(&b, false)]).check().is_ok(), "a chain may have no ECX");
        assert!(with_assets(child(), vec![asset(&a, true), asset(&b, true)]).check().is_err());
        assert!(with_assets(child(), vec![asset(&a, false), asset(&a, false)]).check().is_err());
    }

    #[test]
    fn a_named_asset_has_a_ticker_and_a_name() {
        let child = || entry(Some(24), Some("ecash:betanet"));
        let id = "5a".repeat(32);
        assert!(with_assets(child(), vec![AssetEntry { ticker: "".into(), ..asset(&id, false) }]).check().is_err());
        assert!(with_assets(child(), vec![AssetEntry { name: " ".into(), ..asset(&id, false) }]).check().is_err());
    }

    #[test]
    fn a_chain_has_a_slot_and_a_parent_or_neither() {
        assert!(entry(None, None).check().is_ok());
        assert!(entry(Some(24), Some("ecash:betanet")).check().is_ok());
        assert!(entry(Some(24), None).check().is_err());
        assert!(entry(None, Some("ecash:betanet")).check().is_err());
    }

    #[test]
    fn a_chain_id_ends_in_its_networks_slot() {
        let mut child = entry(Some(46), Some("ecash:betanet"));
        assert!(child.check().is_ok());
        child.networks.get_mut("betanet").unwrap().chain = "ecash:betanet-s99".into();
        assert!(child.check().is_err());
    }

    #[test]
    fn only_a_chain_with_a_parent_has_an_activation_block() {
        let activation = || Some(IdentityBlock { height: 970_715, hash: "11".repeat(32) });
        let mut child = entry(Some(24), Some("ecash:betanet"));
        child.networks.get_mut("betanet").unwrap().activation = activation();
        assert!(child.check().is_ok());
        let mut root = entry(None, None);
        root.networks.get_mut("betanet").unwrap().activation = activation();
        assert!(root.check().is_err());
        child.networks.get_mut("betanet").unwrap().activation = Some(IdentityBlock { height: 1, hash: "xx".into() });
        assert!(child.check().is_err());
    }

    #[test]
    fn only_a_chain_with_a_parent_has_deposit_confirmations_of_at_least_one() {
        let mut child = entry(Some(24), Some("ecash:betanet"));
        child.networks.get_mut("betanet").unwrap().deposit_confirmations = Some(6);
        assert!(child.check().is_ok());
        child.networks.get_mut("betanet").unwrap().deposit_confirmations = Some(0);
        assert!(child.check().is_err());
        let mut root = entry(None, None);
        root.networks.get_mut("betanet").unwrap().deposit_confirmations = Some(6);
        assert!(root.check().is_err());
    }
}
