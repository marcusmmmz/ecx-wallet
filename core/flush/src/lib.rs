//! The Flush Chain Module (Slot 46). Flush is a Bitcoin Core fork with its own genesis, so this is
//! L1's module (`core/l1`) keyed by a Starter instead of the L1 Account Key, and without the
//! replay marker (docs/adr/0011).
//!
//! - [`declare`] reports the binding the module serves;
//! - [`derive_account`] turns the Slot 46 Starter into BIP84 (P2WPKH) addresses and watch data;
//! - [`deposit_destination`] says what a Deposit from eCash is credited to, once Slot 46's
//!   activation is pinned;
//! - [`build_transfer`] builds the wallet's own Send of ECX from the account's coins;
//! - [`check`] refuses, without the Starter, what the wallet must never sign;
//! - [`decode`] is the Flush Decoder: a Clear View of plain payments, or Blind with the facts it
//!   can prove (every Flush operation: tokens, the DEX, staking, withdrawals);
//! - [`sign`] signs only the inputs that re-derive to the Starter, changing nothing else;
//! - [`finalize`] turns a signed PSBT into the transaction to broadcast;
//! - [`output_tokens`] and [`asset_registration`] read tokens and asset names from the
//!   transactions that made them (the `tokens` capability, docs/adr/0013).
//!
//! The module holds nothing between calls and receives only its own Slot's Starter. Every
//! per-network value comes from Slot 46's Chain Entry (`chain-entry.json`), never from constants.
use std::str::FromStr;

use bitcoin::bech32::{self, Hrp};
use bitcoin::bip32::{ChildNumber, DerivationPath, Fingerprint, KeySource, Xpriv, Xpub};
use bitcoin::hashes::Hash;
use bitcoin::secp256k1::{All, PublicKey, Secp256k1, SecretKey};
use bitcoin::{CompressedPublicKey, NetworkKind, ScriptBuf};
use serde::Serialize;

pub mod chain_entry;
mod deposit;
pub mod bast;
mod decode;
mod psbt;
mod sign;
mod tokens;
mod transfer;

pub use chain_entry::{chain_entry, ChainEntry, NetworkEntry, ServerApi, SidechainServerEntry};
pub use deposit::{deposit_destination, long_form, DepositDestination, MAX_DESTINATION_BYTES};
pub use decode::{decode, ClearInput, ClearOutput, ClearView, DangerousMode, Decoded, Destination, VerifiableFacts};
pub use psbt::{check, AssetAmount, OwnedInput, Refusal, RefusalCode};
pub use sign::{finalize, sign, Finalized};
pub use tokens::{asset_registration, output_tokens, CheckedRegistration, OutputToken, OutputTokens, TokenAmount, MAX_DECIMALS};
pub use transfer::{build_transfer, Built, Coin, Payment, PaymentTo, Spent, TransferOrder};

/// The network this build serves (betanet only, until mainnet: #32).
pub const NETWORK: &str = "betanet";

/// The account path under the Starter: BIP84, coin type 1, account 0. Flush Core's own wallet uses
/// coin type 1 on every network but mainnet (`src/wallet/walletutil.cpp`), as LWK does for Slot 24.
pub const ACCOUNT_PATH: &str = "84h/1h/0h";

/// How many receive addresses, from index 0, the wallet gives apps (`getAddresses`). An input or
/// output paying one of them is the wallet's without a `bip32_derivation` entry (docs/adr/0007).
/// Must match `APP_RECEIVE_ADDRESSES` in `wallet/src/accounts.ts`.
pub const APP_RECEIVE_ADDRESSES: u32 = 1;

/// What the module serves: requests for this chain, in this format.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Binding {
    /// CAIP-2, e.g. `ecash:betanet-s46`.
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

/// `depositDestination` only once the Chain Entry pins Slot 46's activation (docs/adr/0004): a
/// Deposit to an inactive Slot is accepted on eCash and its funds are anyone's (#57).
pub fn declare() -> Declaration {
    let mut capabilities = vec!["buildTransfer".to_string(), "tokens".into()];
    if network().activation.is_some() {
        capabilities.push("depositDestination".into());
    }
    Declaration { binding: Binding { chain: network().chain.clone(), format: "psbt".into(), payload_versions: vec!["0".into()] }, capabilities }
}

/// This build's network in Slot 46's Chain Entry.
pub fn network() -> &'static NetworkEntry {
    &chain_entry().networks[NETWORK]
}

/// Addresses and watch data for one Starter.
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

/// The Starter → its account's descriptor, its first `receive_count` receive addresses and its
/// first `change_count` change addresses.
pub fn derive_account(starter: &str, receive_count: u32, change_count: u32) -> Result<Account, String> {
    let keys = AccountKeys::new(starter)?;
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

/// One Starter's account, and what the module derives from it.
pub(crate) struct AccountKeys {
    pub fingerprint: Fingerprint,
    xprv: Xpriv,
    pub xpub: Xpub,
    pub secp: Secp256k1<All>,
}

impl AccountKeys {
    /// The Starter (a 12-word BIP39 mnemonic) → its BIP39 seed with no passphrase → the account at
    /// `m/84'/1'/0'`. Anything else (the L1 Account Key, another phrase) is refused.
    pub fn new(starter: &str) -> Result<Self, String> {
        let mnemonic = bip39::Mnemonic::parse_in(bip39::Language::English, starter).map_err(|e| format!("invalid Starter: {e}"))?;
        let secp = Secp256k1::new();
        let master = Xpriv::new_master(NetworkKind::Test, &mnemonic.to_seed("")).map_err(|e| format!("invalid Starter: {e}"))?;
        let xprv = master.derive_priv(&secp, &account_path()).map_err(|e| e.to_string())?;
        let xpub = Xpub::from_priv(&secp, &xprv);
        Ok(AccountKeys { fingerprint: master.fingerprint(&secp), xprv, xpub, secp })
    }

    /// The full path of `chain`/`index` (0 receive, 1 change), as a PSBT's `bip32_derivation` holds it.
    pub fn path(&self, chain: u32, index: u32) -> DerivationPath {
        account_path().extend([ChildNumber::Normal { index: chain }, ChildNumber::Normal { index }])
    }

    pub fn public_key(&self, chain: u32, index: u32) -> Result<PublicKey, String> {
        let path = [normal(chain)?, normal(index)?];
        Ok(self.xpub.derive_pub(&self.secp, &path).map_err(|e| e.to_string())?.public_key)
    }

    pub fn secret_key(&self, chain: u32, index: u32) -> Result<SecretKey, String> {
        let path = [normal(chain)?, normal(index)?];
        Ok(self.xprv.derive_priv(&self.secp, &path).map_err(|e| e.to_string())?.private_key)
    }

    /// The P2WPKH script of `chain`/`index`.
    pub fn script(&self, chain: u32, index: u32) -> Result<ScriptBuf, String> {
        Ok(ScriptBuf::new_p2wpkh(&CompressedPublicKey(self.public_key(chain, index)?).wpubkey_hash()))
    }

    /// `bip32_derivation`'s entry for `chain`/`index`.
    pub fn key_source(&self, chain: u32, index: u32) -> KeySource {
        (self.fingerprint, self.path(chain, index))
    }

    /// The `(chain, index)` a `bip32_derivation` entry proves: this Starter's fingerprint, a path
    /// `m/84'/1'/0'/<0 or 1>/<i>`, a public key that re-derives from it, and `script` paying it.
    /// None for anything else, including another wallet's entry.
    pub fn owns(&self, pubkey: &PublicKey, (fingerprint, path): &KeySource, script: &ScriptBuf) -> Option<(u32, u32)> {
        let rest = path.as_ref().strip_prefix(account_path().as_ref())?;
        let (chain, index) = match (*fingerprint == self.fingerprint, rest) {
            (true, [ChildNumber::Normal { index: chain @ (0 | 1) }, ChildNumber::Normal { index }]) => (*chain, *index),
            _ => return None,
        };
        let derived = self.public_key(chain, index).ok()?;
        (derived == *pubkey && self.script(chain, index).ok()? == *script).then_some((chain, index))
    }

    /// The receive address apps are given whose script is `script`, as `(chain, index)`: the wallet's
    /// with no `bip32_derivation` entry (docs/adr/0007).
    pub fn given_out(&self, script: &ScriptBuf) -> Option<(u32, u32)> {
        (0..APP_RECEIVE_ADDRESSES).find(|i| self.script(0, *i).ok().as_ref() == Some(script)).map(|i| (0, i))
    }

    /// True if the entry names this Starter's fingerprint, whether or not it re-derives.
    pub fn claims(&self, (fingerprint, _): &KeySource) -> bool {
        *fingerprint == self.fingerprint
    }
}

fn normal(index: u32) -> Result<ChildNumber, String> {
    ChildNumber::from_normal_idx(index).map_err(|e| e.to_string())
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

/// An address in this network's encoding → its script. None for anything else, another network's
/// addresses among them.
pub(crate) fn script_of(address: &str) -> Option<ScriptBuf> {
    let params = &network().params.address_params;
    if let Ok((hrp, version, program)) = bech32::segwit::decode(address) {
        if hrp != Hrp::parse(&params.bech_hrp).ok()? {
            return None;
        }
        let version = bitcoin::WitnessVersion::try_from(version).ok()?;
        let program = bitcoin::WitnessProgram::new(version, &program).ok()?;
        return Some(ScriptBuf::new_witness_program(&program));
    }
    let data = bitcoin::base58::decode_check(address).ok()?;
    let (prefix, hash) = data.split_first()?;
    let hash: [u8; 20] = hash.try_into().ok()?;
    match *prefix {
        p if p == params.p2pkh_prefix => Some(ScriptBuf::new_p2pkh(&bitcoin::PubkeyHash::from_byte_array(hash))),
        p if p == params.p2sh_prefix => Some(ScriptBuf::new_p2sh(&bitcoin::ScriptHash::from_byte_array(hash))),
        _ => None,
    }
}

pub(crate) fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
