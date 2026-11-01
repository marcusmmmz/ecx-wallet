//! The L1 (eCash) Chain Module: the root chain's module (docs/adr/0003).
//!
//! - [`declare`] reports the binding the module serves;
//! - [`derive_account`] turns the L1 Account Key into BIP84 (P2WPKH) addresses and watch data;
//! - [`build_deposit`] builds an M5 (a Deposit to a Slot) from the account's own coins;
//! - [`build_transfer`] builds the wallet's own Send from the account's coins;
//! - [`check`] refuses, without the key, what the wallet must never sign;
//! - [`decode`] is the L1 Decoder: a Clear View, or Blind with the facts it can prove;
//! - [`sign`] signs only the inputs that re-derive to the key, and only a replay-marked spend
//!   with at least one of them;
//! - [`finalize`] turns a signed PSBT into the transaction to broadcast.
//!
//! It receives the L1 Account Key, `[fingerprint/84h/0h/0h]xprv…` (the Vault's `l1_account_key`),
//! and never a Starter or the Master Mnemonic. It holds nothing between calls. Every per-network
//! value comes from eCash's Chain Entry (`chain-entry.json`), never from constants.
use std::str::FromStr;

use bitcoin::bech32::{self, Hrp};
use bitcoin::bip32::{ChildNumber, DerivationPath, Fingerprint, Xpriv, Xpub};
use bitcoin::secp256k1::{All, PublicKey, Secp256k1, SecretKey};
use bitcoin::{CompressedPublicKey, ScriptBuf};
use serde::Serialize;

pub mod chain_entry;
mod decode;
mod deposit;
mod psbt;
mod sign;
mod transfer;

pub use chain_entry::{chain_entry, ChainEntry, NetworkEntry, OpDrivechain, ServerApi, SidechainServerEntry};
pub use decode::{decode, ClearInput, ClearOutput, ClearView, DangerousMode, Decoded, Destination, VerifiableFacts};
pub use deposit::{build_deposit, treasury_script, txid, Built, Coin, DepositOrder, PrevOut, Spent};
pub use psbt::{check, AssetAmount, OwnedInput, Refusal, RefusalCode};
pub use sign::{finalize, sign, Finalized};
pub use transfer::{build_transfer, BuiltTransfer, Payment, PaymentTo, TransferOrder};

/// The network this build serves, its key in the Chain Entry: `$ECX_NETWORK` at build time (build.rs).
pub const NETWORK: &str = env!("ECX_NETWORK");

/// The account path the L1 Account Key sits at: BIP84, coin type 0 (ECX shares Bitcoin's keys), account 0.
pub const ACCOUNT_PATH: &str = "84h/0h/0h";

/// What the module serves: requests for this chain, in this format.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Binding {
    /// CAIP-2, e.g. `ecash:betanet`.
    pub chain: String,
    pub format: String,
    /// Payload versions the Decoder understands: BIP174's PSBT version 0.
    pub payload_versions: Vec<String>,
}

/// `declare()`'s answer: the binding plus optional capabilities.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Declaration {
    pub binding: Binding,
    pub capabilities: Vec<String>,
}

pub fn declare() -> Declaration {
    Declaration {
        binding: Binding { chain: network().chain.clone(), format: "psbt".into(), payload_versions: vec!["0".into()] },
        capabilities: vec!["buildDeposit".into(), "buildTransfer".into()],
    }
}

/// This build's network in eCash's Chain Entry.
pub fn network() -> &'static NetworkEntry {
    &chain_entry().networks[NETWORK]
}

/// Addresses and watch data for the L1 Account Key.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    /// Watch data: the public descriptor (fingerprint + xpub, both chains).
    pub descriptor: String,
    /// External (receive) addresses, from index 0.
    pub receive: Vec<AddressEntry>,
    /// Internal (change) addresses, from index 0.
    pub change: Vec<AddressEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AddressEntry {
    pub index: u32,
    pub address: String,
    /// Hex.
    pub script_pubkey: String,
    /// The key the script pays: 33-byte compressed, hex.
    pub public_key: String,
}

/// The L1 Account Key → its account's descriptor, its first `receive_count` receive addresses and
/// its first `change_count` change addresses.
pub fn derive_account(account_key: &str, receive_count: u32, change_count: u32) -> Result<Account, String> {
    let keys = AccountKeys::new(account_key)?;
    let descriptor = format!("wpkh([{}/{ACCOUNT_PATH}]{}/<0;1>/*)", keys.fingerprint, keys.xpub);
    let addresses = |chain: u32, count: u32| {
        (0..count)
            .map(|index| {
                let script = keys.script(chain, index)?;
                let address = address(&script).ok_or("P2WPKH has an address")?;
                let public_key = hex(&keys.public_key(chain, index)?.serialize());
                Ok(AddressEntry { index, address, script_pubkey: hex(script.as_bytes()), public_key })
            })
            .collect::<Result<Vec<_>, String>>()
    };
    Ok(Account { descriptor, receive: addresses(0, receive_count)?, change: addresses(1, change_count)? })
}

/// The L1 Account Key, parsed, and what the module derives from it.
pub(crate) struct AccountKeys {
    pub fingerprint: Fingerprint,
    xprv: Xpriv,
    pub xpub: Xpub,
    pub secp: Secp256k1<All>,
}

impl AccountKeys {
    /// `[fingerprint/84h/0h/0h]xprv…` → the keys. Anything else (a Starter, a bare xprv, another
    /// path) is refused.
    pub fn new(account_key: &str) -> Result<Self, String> {
        let invalid = || "invalid L1 Account Key: expected [fingerprint/84h/0h/0h]xprv…".to_string();
        let (origin, key) = account_key.strip_prefix('[').and_then(|rest| rest.split_once(']')).ok_or_else(invalid)?;
        let (fingerprint, path) = origin.split_once('/').ok_or_else(invalid)?;
        let fingerprint = Fingerprint::from_str(fingerprint).map_err(|_| invalid())?;
        if DerivationPath::from_str(&format!("m/{path}")).map_err(|_| invalid())? != account_path() {
            return Err(invalid());
        }
        let xprv = Xpriv::from_str(key).map_err(|_| invalid())?;
        if xprv.depth != 3 || xprv.child_number != account_path()[2] {
            return Err(invalid());
        }
        let secp = Secp256k1::new();
        let xpub = Xpub::from_priv(&secp, &xprv);
        Ok(AccountKeys { fingerprint, xprv, xpub, secp })
    }

    /// The full path of `chain`/`index` (0 receive, 1 change), as a PSBT's `bip32_derivation` holds it.
    pub fn path(&self, chain: u32, index: u32) -> DerivationPath {
        account_path().extend([ChildNumber::Normal { index: chain }, ChildNumber::Normal { index }])
    }

    pub fn public_key(&self, chain: u32, index: u32) -> Result<PublicKey, String> {
        let path = [ChildNumber::Normal { index: chain }, ChildNumber::Normal { index }];
        Ok(self.xpub.derive_pub(&self.secp, &path).map_err(|e| e.to_string())?.public_key)
    }

    pub fn secret_key(&self, chain: u32, index: u32) -> Result<SecretKey, String> {
        let path = [ChildNumber::Normal { index: chain }, ChildNumber::Normal { index }];
        Ok(self.xprv.derive_priv(&self.secp, &path).map_err(|e| e.to_string())?.private_key)
    }

    /// The P2WPKH script of `chain`/`index`.
    pub fn script(&self, chain: u32, index: u32) -> Result<ScriptBuf, String> {
        Ok(ScriptBuf::new_p2wpkh(&CompressedPublicKey(self.public_key(chain, index)?).wpubkey_hash()))
    }

    /// The `(chain, index)` a `bip32_derivation` entry proves: this key's fingerprint, a path
    /// `m/84'/0'/0'/<0 or 1>/<i>`, a public key that re-derives from it, and `script` paying it.
    /// None for anything else, including another wallet's entry.
    pub fn owns(&self, pubkey: &PublicKey, (fingerprint, path): &(Fingerprint, DerivationPath), script: &ScriptBuf) -> Option<(u32, u32)> {
        let rest = path.as_ref().strip_prefix(account_path().as_ref())?;
        let (chain, index) = match (*fingerprint == self.fingerprint, rest) {
            (true, [ChildNumber::Normal { index: chain @ (0 | 1) }, ChildNumber::Normal { index }]) => (*chain, *index),
            _ => return None,
        };
        let derived = self.public_key(chain, index).ok()?;
        (derived == *pubkey && self.script(chain, index).ok()? == *script).then_some((chain, index))
    }

    /// True if the entry names this key's fingerprint, whether or not it re-derives.
    pub fn claims(&self, (fingerprint, _): &(Fingerprint, DerivationPath)) -> bool {
        *fingerprint == self.fingerprint
    }
}

fn account_path() -> DerivationPath {
    DerivationPath::from_str(&format!("m/{ACCOUNT_PATH}")).expect("valid path")
}

/// `script` as an address in this network's encoding (the Chain Entry's `addressParams`): P2PKH
/// and P2SH in base58check, segwit in bech32/bech32m. None for any other script.
pub(crate) fn address(script: &ScriptBuf) -> Option<String> {
    let params = &network().params.address_params;
    let base58 = |prefix: u8, hash: &[u8]| Some(bitcoin::base58::encode_check(&[&[prefix][..], hash].concat()));
    match script.as_bytes() {
        [0x76, 0xa9, 0x14, hash @ .., 0x88, 0xac] if hash.len() == 20 => base58(params.p2pkh_prefix, hash),
        [0xa9, 0x14, hash @ .., 0x87] if hash.len() == 20 => base58(params.p2sh_prefix, hash),
        [version @ (0x00 | 0x51..=0x60), len, program @ ..] if *len as usize == program.len() => {
            let version = bech32::Fe32::try_from(if *version == 0 { 0 } else { version - 0x50 }).ok()?;
            let hrp = Hrp::parse(&params.bech_hrp).expect("Chain Entry bech HRP is valid");
            bech32::segwit::encode(hrp, version, program).ok()
        }
        _ => None,
    }
}

pub(crate) fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
