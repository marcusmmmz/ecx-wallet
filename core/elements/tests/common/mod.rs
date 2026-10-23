//! Fixture PSETs for Seam 2 (and, through `fixtures.rs`, for the e2e suite), built offline.
//!
//! Keys come from the public descriptor `derive_account` returns, so a fixture input "belongs" to a
//! Starter exactly as a Sidechain Server would describe it: fingerprint, path, pubkey, script.
#![allow(dead_code)]

use std::str::FromStr;

use ecx_elements::{derive_account, network};
use elements_miniscript::bitcoin::bip32::{DerivationPath, Fingerprint};
use elements_miniscript::elements::confidential::{Asset, Nonce, Value};
use elements_miniscript::elements::hashes::Hash;
use elements_miniscript::elements::pset::raw::ProprietaryKey;
use elements_miniscript::elements::pset::{Input, Output, PartiallySignedTransaction};
use elements_miniscript::elements::{AssetId, BlockHash, ContractHash, OutPoint, Script, TxOut, TxOutWitness, Txid};
use elements_miniscript::{Descriptor, DescriptorPublicKey, ForEachKey, ToPublicKey};

/// The Slot 24 Starter of "abandon … about", no passphrase (the e2e wallet).
pub const STARTER: &str = "buyer citizen congress doll secret merry denial law live wait pass drive";
/// Some other wallet's Starter.
pub const FOREIGN: &str = "blush cream bullet drive index disease noble east target dice put rate";

pub type Pset = PartiallySignedTransaction;
pub type PublicKey = elements_miniscript::bitcoin::PublicKey;

/// One wallet key as a PSET describes it.
#[derive(Clone)]
pub struct Key {
    pub pk: PublicKey,
    pub fingerprint: Fingerprint,
    pub path: DerivationPath,
    pub script_pubkey: Script,
}

/// `starter`'s key at `<chain>/<index>` of its `elwpkh` account.
pub fn key(starter: &str, chain: u32, index: u32) -> Key {
    let desc = Descriptor::<DescriptorPublicKey>::from_str(&derive_account(starter, 0, 0).unwrap().descriptor).unwrap();
    let single = desc.into_single_descriptors().unwrap().swap_remove(chain as usize);
    let at = single.at_derivation_index(index).unwrap();
    let mut found = None;
    at.for_each_key(|k| {
        found = Some((k.to_public_key(), k.master_fingerprint(), k.full_derivation_path().unwrap()));
        true
    });
    let (pk, fingerprint, path) = found.unwrap();
    Key { pk, fingerprint, path, script_pubkey: at.script_pubkey() }
}

pub fn policy_asset() -> AssetId {
    AssetId::from_str(&network().params.policy_asset).unwrap()
}

/// The ELIP-101 global field (display hex → internal byte order).
pub fn set_genesis(pset: &mut Pset, display_hex: &str) {
    let hash = BlockHash::from_str(display_hex).unwrap();
    pset.global.proprietary.insert(ProprietaryKey::from_pset_pair(0x02, vec![]), hash.to_byte_array().to_vec());
}

pub fn new_pset() -> Pset {
    let mut pset = Pset::new_v2();
    set_genesis(&mut pset, &network().params.genesis_hash);
    pset
}

/// An explicit policy-asset UTXO paying `key`, with `witness_utxo` and `bip32_derivation`.
pub fn input(key: &Key, value: u64, prev: u8) -> Input {
    let mut inp = Input::from_prevout(OutPoint::new(Txid::from_byte_array([prev; 32]), 0));
    inp.witness_utxo = Some(TxOut {
        asset: Asset::Explicit(policy_asset()),
        value: Value::Explicit(value),
        nonce: Nonce::Null,
        script_pubkey: key.script_pubkey.clone(),
        witness: TxOutWitness::default(),
    });
    inp.bip32_derivation.insert(key.pk, (key.fingerprint, key.path.clone()));
    inp
}

pub fn pay(script_pubkey: Script, value: u64) -> Output {
    Output::new_explicit(script_pubkey, value, policy_asset(), None)
}

/// An output back to a wallet key, carrying its derivation so the wallet can re-derive it.
pub fn change(key: &Key, value: u64) -> Output {
    let mut out = pay(key.script_pubkey.clone(), value);
    out.bip32_derivation.insert(key.pk, (key.fingerprint, key.path.clone()));
    out
}

pub fn fee(value: u64) -> Output {
    pay(Script::new(), value)
}

/// `transfer()` with its fee split over two fee outputs (1 000 + 500; change shrinks by 500).
pub fn with_two_fee_outputs() -> Pset {
    let mut pset = transfer();
    pset.outputs_mut()[1].amount = Some(28_500);
    pset.add_output(fee(500));
    pset
}

/// One owned input (100 000) and one foreign input (50 000), paying a foreign address 120 000,
/// 29 000 change back to us, and a 1 000 fee.
pub fn transfer() -> Pset {
    let mut pset = new_pset();
    pset.add_input(input(&key(STARTER, 0, 0), 100_000, 1));
    pset.add_input(input(&key(FOREIGN, 0, 0), 50_000, 2));
    pset.add_output(pay(key(FOREIGN, 0, 1).script_pubkey, 120_000));
    pset.add_output(change(&key(STARTER, 1, 0), 29_000));
    pset.add_output(fee(1_000));
    pset
}

/// Hex → bytes.
pub fn hex_bytes(hex: &str) -> Vec<u8> {
    (0..hex.len()).step_by(2).map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap()).collect()
}

pub fn b64(pset: &Pset) -> String {
    pset.to_string()
}

pub fn parse(b64: &str) -> Pset {
    Pset::from_str(b64).unwrap()
}

/// `starter`'s key at an arbitrary `path` (outside its account), with a p2wpkh script.
pub fn key_at_path(starter: &str, path: &str) -> Key {
    use lwk_common::Signer;
    let signer = lwk_signer::SwSigner::new(starter, false).unwrap();
    let path = DerivationPath::from_str(path).unwrap();
    let xpub = signer.derive_xpub(&path).unwrap();
    let pk = PublicKey::new(xpub.public_key);
    let wpkh = elements_miniscript::elements::WPubkeyHash::from_byte_array(pk.wpubkey_hash().unwrap().to_byte_array());
    Key { pk, fingerprint: signer.fingerprint(), path, script_pubkey: Script::new_v0_wpkh(&wpkh) }
}

/// `transfer()` plus fields the Decoder doesn't know: an unknown global, input and output key,
/// and a foreign proprietary input field.
pub fn transfer_with_unknown_fields() -> Pset {
    use elements_miniscript::elements::pset::raw;
    let mut pset = transfer();
    pset.global.unknown.insert(raw::Key { type_value: 0xf0, key: vec![0xaa] }, vec![1, 2, 3]);
    pset.inputs_mut()[0].unknown.insert(raw::Key { type_value: 0xf1, key: vec![] }, vec![0xde, 0xad, 0xbe, 0xef]);
    pset.inputs_mut()[0]
        .proprietary
        .insert(ProprietaryKey { prefix: b"acme".to_vec(), subtype: 7, key: vec![9] }, vec![0x42; 5]);
    pset.outputs_mut()[0].unknown.insert(raw::Key { type_value: 0xf2, key: vec![0xbb, 0xcc] }, vec![7; 40]);
    pset
}

/// `transfer_with_unknown_fields()` that is also a swap: a third, foreign input brings 500 of
/// another asset, paid to our change key. Blind, with something coming in.
pub fn blind_swap() -> Pset {
    let other = AssetId::from_slice(&[0x77; 32]).unwrap();
    let mut pset = transfer_with_unknown_fields();
    let mut theirs = input(&key(FOREIGN, 0, 2), 500, 3);
    theirs.witness_utxo.as_mut().unwrap().asset = Asset::Explicit(other);
    pset.add_input(theirs);
    let ours = key(STARTER, 1, 1);
    let mut incoming = Output::new_explicit(ours.script_pubkey.clone(), 500, other, None);
    incoming.bip32_derivation.insert(ours.pk, (ours.fingerprint, ours.path.clone()));
    pset.add_output(incoming);
    pset
}

/// `transfer()` whose foreign input's UTXO has a confidential (committed) value.
pub fn with_confidential_input() -> Pset {
    use elements_miniscript::elements::secp256k1_zkp::{Generator, PedersenCommitment, Secp256k1};
    let secp = Secp256k1::new();
    let generator = Generator::new_unblinded(&secp, policy_asset().into_tag());
    let mut pset = transfer();
    let utxo = pset.inputs_mut()[1].witness_utxo.as_mut().unwrap();
    utxo.value = Value::Confidential(PedersenCommitment::new_unblinded(&secp, 50_000, generator));
    pset
}

/// `transfer()` whose foreign payment is meant to be blinded (it carries the public key to blind it to).
pub fn with_confidential_output() -> Pset {
    let mut pset = transfer();
    pset.outputs_mut()[0].blinding_key = Some(key(FOREIGN, 0, 1).pk);
    pset.outputs_mut()[0].blinder_index = Some(0);
    pset
}

/// `transfer()` whose foreign input doesn't say whose key it needs.
pub fn with_missing_derivation() -> Pset {
    let mut pset = transfer();
    pset.inputs_mut()[1].bip32_derivation.clear();
    pset
}

/// What the DEX builds for an issuance (#45): one 100 000 coin at our `0/0`, issuing 1 000 000 of a
/// new asset and 1 reissuance token, both back to `0/0` with 99 000 change and a 1 000 fee. No
/// `bip32_derivation` anywhere: the DEX knows only the address.
pub fn dex_issuance() -> Pset {
    issuance_committing_to([0x5c; 32])
}

/// `dex_issuance()`, committing to the contract whose SHA-256 is `contract_hash` (its raw bytes).
pub fn issuance_committing_to(contract_hash: [u8; 32]) -> Pset {
    let ours = key(STARTER, 0, 0);
    let mut inp = input(&ours, 100_000, 1);
    inp.bip32_derivation.clear();
    let entropy = AssetId::generate_asset_entropy(OutPoint::new(inp.previous_txid, inp.previous_output_index),ContractHash::from_byte_array(contract_hash));
    inp.issuance_value_amount = Some(1_000_000);
    inp.issuance_inflation_keys = Some(1);
    inp.issuance_asset_entropy = Some(contract_hash);
    let mut pset = new_pset();
    pset.add_input(inp);
    pset.add_output(Output::new_explicit(ours.script_pubkey.clone(), 1_000_000, AssetId::from_entropy(entropy), None));
    pset.add_output(Output::new_explicit(ours.script_pubkey.clone(), 1, AssetId::reissuance_token_from_entropy(entropy, false), None));
    pset.add_output(pay(ours.script_pubkey.clone(), 99_000));
    pset.add_output(fee(1_000));
    pset
}

/// A Liquid-registry contract for an asset issued by `issuer`, as the DEX writes it: sorted keys,
/// compact.
pub fn contract(issuer: &Key, ticker: &str) -> String {
    let pk: String = issuer.pk.inner.serialize().iter().map(|b| format!("{b:02x}")).collect();
    format!(r#"{{"entity":{{"domain":"dex.example"}},"issuer_pubkey":"{pk}","name":"Example Asset","precision":8,"ticker":"{ticker}","version":0}}"#)
}

/// The issuance PSET committing to exactly `contract`'s bytes.
pub fn issuance_of(contract: &str) -> Pset {
    use elements_miniscript::elements::hashes::sha256;
    issuance_committing_to(sha256::Hash::hash(contract.as_bytes()).to_byte_array())
}

/// `pset` with `key`'s derivation on every input and output that pays its script.
pub fn with_derivations(mut pset: Pset, key: &Key) -> Pset {
    for inp in pset.inputs_mut() {
        if inp.witness_utxo.as_ref().is_some_and(|u| u.script_pubkey == key.script_pubkey) {
            inp.bip32_derivation.insert(key.pk, (key.fingerprint, key.path.clone()));
        }
    }
    for out in pset.outputs_mut() {
        if out.script_pubkey == key.script_pubkey {
            out.bip32_derivation.insert(key.pk, (key.fingerprint, key.path.clone()));
        }
    }
    pset
}

/// `transfer()` without our input: nothing in it is ours to sign.
pub fn foreign_only() -> Pset {
    let mut pset = new_pset();
    pset.add_input(input(&key(FOREIGN, 0, 0), 50_000, 2));
    pset.add_output(pay(key(FOREIGN, 0, 1).script_pubkey, 49_000));
    pset.add_output(fee(1_000));
    pset
}

/// A withdrawal burn script: OP_RETURN <parent genesis> <L1 script> <fee, BE u64>.
pub fn withdrawal_burn_script() -> Script {
    withdrawal_burn_script_to(&[&[0x00, 0x14][..], &[0x11; 20]].concat())
}

/// A withdrawal burn paying `l1_script` on L1, with a 1 000 parent fee.
pub fn withdrawal_burn_script_to(l1_script: &[u8]) -> Script {
    use elements_miniscript::elements::opcodes::all::OP_RETURN;
    use elements_miniscript::elements::script::Builder;
    let parent = BlockHash::from_str(&network().params.parent_genesis_hash).unwrap();
    Builder::new()
        .push_opcode(OP_RETURN)
        .push_slice(parent.as_byte_array())
        .push_slice(l1_script)
        .push_slice(&1_000u64.to_be_bytes())
        .into_script()
}

/// `starter`'s address at `<chain>/<index>`, in the Chain Entry's encoding (`elements1…`).
pub fn address(starter: &str, chain: u32, index: u32) -> String {
    use elements_miniscript::elements::{Address, AddressParams};
    let p = &network().params.address_params;
    let params: &'static AddressParams = Box::leak(Box::new(AddressParams {
        p2pkh_prefix: p.p2pkh_prefix,
        p2sh_prefix: p.p2sh_prefix,
        blinded_prefix: p.blinded_prefix,
        bech_hrp: bech32::Hrp::parse(&p.bech_hrp).unwrap(),
        blech_hrp: bech32::Hrp::parse(&p.blech_hrp).unwrap(),
    }));
    Address::from_script(&key(starter, chain, index).script_pubkey, None, params).unwrap().to_string()
}

/// `transfer()` plus a 5 000 withdrawal burn (output 3) to an L1 p2wpkh, paying a 1 000 parent fee.
pub fn with_withdrawal() -> Pset {
    let mut pset = transfer();
    pset.outputs_mut()[1].amount = Some(24_000); // change shrinks by the burn
    pset.add_output(pay(withdrawal_burn_script(), 5_000));
    pset
}

/// `with_withdrawal()` whose owned input signs with SINGLE|ANYONECANPAY: two dangerous modes.
pub fn dangerous() -> Pset {
    let mut pset = with_withdrawal();
    pset.inputs_mut()[0].sighash_type = Some(elements_miniscript::elements::pset::PsbtSighashType::from_u32(0x83));
    pset
}
