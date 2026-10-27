//! Flush's Chain Entry: the one place its per-network values live. It ships with the module
//! (embedded from `chain-entry.json`) and the wallet reads it through `chain_entry()`. The envelope
//! is `ecx-chain-entry`'s; `params` are this module's own.
//!
//! On betanet Flush is Slot 99, the temporary chain its node calls "Photon"; Slot 46 is
//! mainnet's (docs/adr/0014). Sources are github.com/block-fabric/backbone-flush at commit
//! `48e822b`, read 2026-10-25, and the live chains, read 2026-10-27:
//!
//! - **Identity:** height 0, `04dfb01b…`, the genesis Flush's explorer serves. (`7d66b10e…`, the
//!   betanet genesis `MakeSidechain` derives for Slot 46, is that chain's if it ever runs there.)
//! - **`activation`:** eCash block 968,998 (`00000000000000012009a1…acd5ae`), the last of 1,009
//!   consecutive M2 ACKs (`d6e1c5df 63 4ec9a1a1…d3d6ced6`, from 967,990) for the "Photon" M1 in
//!   block 967,989, read from esplora.beta. No M2 for Slot 99 follows it, and the first M5 to Slot
//!   99 is in block 973,928.
//! - **`depositConfirmations`: 2.** A Deposit in eCash block N is paid by the first Flush block
//!   whose acknowledgement covers N (`ack.mainheight − 1 ≥ N`), in practice after N+1; all seven
//!   Deposits seen on the Slot 99 chain fit (research on #55).
//! - **ECX:** the chain's native coin, 1:1 with eCash's (`src/consensus/amount.h`; Deposits are
//!   credited sat for sat, `src/sidechain/state.cpp:325-330`). Its explorer reports it with no
//!   asset id, so the entry names it with the empty id (docs/adr/0005).
//! - **Address params:** `CEcashSidechainParams` copies `CMainParams` (P2PKH 0, P2SH 5) and sets
//!   only the HRP, `bflx` on betanet.
//! - **Server:** Flush's explorer, `explorer.blockfab.org/betanet/flush/api`.
//!
//! `build.rs` picks the file: `chain-entry.json`, or `$ECX_FLUSH_CHAIN_ENTRY` for the e2e build,
//! whose Chain Entry differs only in its Sidechain Servers.
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};

pub use ecx_chain_entry::{AssetEntry, IdentityBlock, ServerApi, SidechainServerEntry};

/// The raw JSON, as shipped.
pub const CHAIN_ENTRY_JSON: &str = include_str!(env!("ECX_FLUSH_CHAIN_ENTRY_PATH"));

pub type ChainEntry = ecx_chain_entry::ChainEntry<FlushParams>;
pub type NetworkEntry = ecx_chain_entry::NetworkEntry<FlushParams>;

/// Flush's own per-network values.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FlushParams {
    pub address_params: AddressParamsEntry,
}

/// Bitcoin Core's `base58Prefixes` and `bech32_hrp`, as Flush's chain params set them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AddressParamsEntry {
    pub p2pkh_prefix: u8,
    pub p2sh_prefix: u8,
    pub bech_hrp: String,
}

/// The parsed Chain Entry. The JSON is compiled in, so a parse failure is a build bug.
pub fn chain_entry() -> &'static ChainEntry {
    static ENTRY: OnceLock<ChainEntry> = OnceLock::new();
    ENTRY.get_or_init(|| {
        let entry: ChainEntry = serde_json::from_str(CHAIN_ENTRY_JSON).expect("chain-entry.json is valid");
        check_chain_entry(&entry).expect("chain-entry.json is valid");
        entry
    })
}

/// The envelope's rules, and Flush's own: a network's ECX, if it names one, is the native coin
/// (the empty id), the only asset a Deposit is credited in and a Send spends.
pub fn check_chain_entry(entry: &ChainEntry) -> Result<(), String> {
    entry.check()?;
    for (name, network) in &entry.networks {
        if network.ecx_asset().is_some_and(|ecx| !ecx.id.is_empty()) {
            return Err(format!("{}'s {name}: its ECX must be the native coin, with the empty id", entry.name));
        }
    }
    Ok(())
}
