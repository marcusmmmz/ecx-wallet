//! `deposit_destination(starter)`: what a Deposit to Slot 46 is credited to, in the bytes an M5's
//! `OP_RETURN` carries, and the chain's rules for it (#57).
//!
//! Flush reads the destination as `s<slot>_<address>_<checksum>`, the checksum the first 6 hex
//! digits of the SHA-256 of `s<slot>_<address>_` (backbone-flush `src/drivechain/sidechain.cpp`,
//! `DepositChecksum`). A wrong slot or checksum is paid to a bare `OP_RETURN`, burned
//! (`DepositScript`, `src/sidechain/script.cpp`). Flush credits a bare address the same way; this
//! writes the long form, as Flush's own wallet does, which ties the Deposit to this Slot and lets
//! the explorer's `/flush/deposit/:txid` name its address.
//!
//! The credit is a coinbase output paying the address exactly the Deposit's value, after the M5's
//! eCash block is acknowledged (`src/sidechain/state.cpp`): no fee, and no minimum on Flush's side.
use bitcoin::hashes::{sha256, Hash};
use serde::Serialize;

use crate::{chain_entry, derive_account, network};

/// Backbone's `MAX_DEPOSIT_DESTINATION_SIZE`: its RPC's cap, consensus once `limits_activation_height` is set.
pub const MAX_DESTINATION_BYTES: usize = 100;

/// The smallest Deposit, in sats: the credit's P2WPKH output at Flush's dust threshold (294 sat).
/// Flush has no minimum; a smaller coin would cost more to spend than it holds.
const MINIMUM_DEPOSIT: u64 = 294;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DepositDestination {
    /// The Starter's first receive address, which the Deposit is credited to.
    pub address: String,
    /// The bytes the M5's `OP_RETURN` pushes, hex: `s46_<address>_<checksum>` in ASCII.
    pub destination: String,
    /// The asset the credit arrives in: "", Flush's ECX.
    pub asset: String,
    /// Sats, as a decimal string: the smallest Deposit the wallet builds.
    pub minimum: String,
    /// The address's script, hex: what the credit's coinbase output pays.
    pub script_pubkey: String,
}

/// `s<slot>_<address>_<checksum>`: the destination Flush checks a Deposit to `slot` against.
pub fn long_form(slot: u32, address: &str) -> String {
    let prefix = format!("s{slot}_{address}_");
    let digest = sha256::Hash::hash(prefix.as_bytes()).to_byte_array();
    format!("{prefix}{}", crate::hex(&digest[..3]))
}

pub fn deposit_destination(starter: &str) -> Result<DepositDestination, String> {
    if network().activation.is_none() {
        return Err("Slot 46's Chain Entry pins no activation block: this wallet makes no Deposit to it (docs/adr/0004).".into());
    }
    let slot = chain_entry().slot.ok_or("Slot 46's Chain Entry names no slot")?;
    let entry = derive_account(starter, 1, 0)?.receive.remove(0);
    let destination = long_form(slot, &entry.address);
    if destination.len() > MAX_DESTINATION_BYTES {
        return Err(format!("{destination} is longer than a Deposit's {MAX_DESTINATION_BYTES}-byte destination"));
    }
    Ok(DepositDestination {
        address: entry.address,
        destination: crate::hex(destination.as_bytes()),
        asset: String::new(),
        minimum: MINIMUM_DEPOSIT.to_string(),
        script_pubkey: entry.script_pubkey,
    })
}
