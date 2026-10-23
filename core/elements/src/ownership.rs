//! Which inputs and outputs belong to this Starter, proven by re-deriving them (spec story 43).
//!
//! LWK's `SwSigner` signs any input whose `bip32_derivation` carries our fingerprint and re-derives
//! to the listed pubkey: it checks neither the path's shape nor the UTXO's script. So ownership is
//! decided here, and only inputs that pass are ever shown to LWK:
//! - the path is this account's: `m/84'/1'/0'/{0,1}/i` (`i` unhardened);
//! - the account xpub, derived at `{0,1}/i`, gives exactly the listed pubkey;
//! - the script is that pubkey's p2wpkh.
//!
//! With no `bip32_derivation` at all, an input or output is still ours if its script is the p2wpkh
//! of a receive address the wallet gives apps (`getAddresses`): an app that knows only that address
//! can't write the entry (#45, docs/adr/0007). Any other key of ours must be named by the entry.
use std::str::FromStr;

use elements_miniscript::bitcoin::bip32::{ChildNumber, DerivationPath, Fingerprint, KeySource, Xpub};
use elements_miniscript::bitcoin::secp256k1::{Secp256k1, VerifyOnly};
use elements_miniscript::bitcoin::PublicKey;
use elements_miniscript::elements::hashes::Hash;
use elements_miniscript::elements::pset::{Input, Output};
use elements_miniscript::elements::{Script, WPubkeyHash};
use lwk_common::Signer;
use lwk_signer::SwSigner;

use crate::account::{ACCOUNT_PATH, APP_RECEIVE_ADDRESSES};

/// One Starter's account, ready to recognise its own keys.
pub(crate) struct Wallet {
    pub(crate) signer: SwSigner,
    fingerprint: Fingerprint,
    account_path: DerivationPath,
    account_xpub: Xpub,
    secp: Secp256k1<VerifyOnly>,
    /// The receive keys apps are given, recognised by their script alone.
    given_out: Vec<(PublicKey, KeySource)>,
}

impl Wallet {
    pub(crate) fn new(starter: &str) -> Result<Self, String> {
        let signer = SwSigner::new(starter, false).map_err(|e| format!("invalid Starter: {e}"))?;
        let account_path = DerivationPath::from_str(&format!("m/{ACCOUNT_PATH}")).expect("valid path");
        let account_xpub = signer.derive_xpub(&account_path).map_err(|e| format!("derive xpub: {e:?}"))?;
        let mut wallet = Wallet {
            fingerprint: signer.fingerprint(),
            signer,
            account_path,
            account_xpub,
            secp: Secp256k1::verification_only(),
            given_out: vec![],
        };
        // Filled after construction: `key` derives from the account xpub on `self`.
        wallet.given_out = (0..APP_RECEIVE_ADDRESSES).map(|i| wallet.key(0, i)).collect::<Result<_, _>>()?;
        Ok(wallet)
    }

    /// The key of `input` that provably belongs to this wallet: its one `bip32_derivation` entry
    /// that does, or, with no entries, the given-out receive key its script pays.
    pub(crate) fn owned_input_key(&self, input: &Input) -> Option<(PublicKey, KeySource)> {
        let script = &input.witness_utxo.as_ref()?.script_pubkey;
        if input.bip32_derivation.is_empty() {
            return self.given_out_key(script);
        }
        self.owned_key(&input.bip32_derivation, script)
    }

    /// True if `output` pays this wallet, proven the same way as for inputs.
    pub(crate) fn owns_output(&self, output: &Output) -> bool {
        match output.bip32_derivation.len() {
            0 => self.given_out_key(&output.script_pubkey).is_some(),
            1 => self.owned_key(&output.bip32_derivation, &output.script_pubkey).is_some(),
            _ => false,
        }
    }

    fn given_out_key(&self, script: &Script) -> Option<(PublicKey, KeySource)> {
        self.given_out.iter().find(|(pk, _)| *script == p2wpkh(pk)).cloned()
    }

    fn owned_key<'a>(
        &self,
        derivations: impl IntoIterator<Item = (&'a PublicKey, &'a KeySource)>,
        script: &Script,
    ) -> Option<(PublicKey, KeySource)> {
        derivations
            .into_iter()
            .find(|(pk, (fp, path))| *fp == self.fingerprint && self.derives(path, pk) && *script == p2wpkh(pk))
            .map(|(pk, source)| (*pk, source.clone()))
    }

    /// The key at `<account>/<chain>/<index>`, as a PSET's `bip32_derivation` holds it.
    pub(crate) fn key(&self, chain: u32, index: u32) -> Result<(PublicKey, KeySource), String> {
        let normal = |i: u32| ChildNumber::from_normal_idx(i).map_err(|e| e.to_string());
        let rest = [normal(chain)?, normal(index)?];
        let child = self.account_xpub.derive_pub(&self.secp, &rest).map_err(|e| e.to_string())?;
        Ok((PublicKey::new(child.public_key), (self.fingerprint, self.account_path.extend(rest))))
    }

    /// True if `path` is `<account>/{0,1}/i` and derives to `pk`.
    fn derives(&self, path: &DerivationPath, pk: &PublicKey) -> bool {
        let Some(rest) = path.as_ref().strip_prefix(self.account_path.as_ref()) else { return false };
        let [chain @ ChildNumber::Normal { index: 0 | 1 }, index @ ChildNumber::Normal { .. }] = rest else {
            return false;
        };
        self.account_xpub
            .derive_pub(&self.secp, &[*chain, *index])
            .is_ok_and(|child| child.public_key == pk.inner && pk.compressed)
    }
}

pub(crate) fn p2wpkh(pk: &PublicKey) -> Script {
    Script::new_v0_wpkh(&WPubkeyHash::hash(&pk.inner.serialize()))
}

impl Wallet {
    /// True if any of `input`'s derivations names this wallet's fingerprint (proven or not).
    pub(crate) fn claims_our_key(&self, input: &Input) -> bool {
        input.bip32_derivation.values().any(|(fp, _)| *fp == self.fingerprint)
    }
}
