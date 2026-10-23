//! Seam 2: `sign(payload, starter)` through the Chain Module's public interface. Signatures are
//! checked against an independently computed segwit-v0 sighash, never against the module's output.
mod common;

use common::*;
use ecx_elements::sign;
use elements_miniscript::elements::confidential::Value;
use elements_miniscript::elements::secp256k1_zkp::{ecdsa::Signature, Message, Secp256k1};
use elements_miniscript::elements::sighash::SighashCache;
use elements_miniscript::elements::{EcdsaSighashType, PubkeyHash, Script};
use elements_miniscript::elements::hashes::Hash;

/// True if `pset`'s input `i` carries a valid ALL signature by `key` over the explicit `value`.
fn has_valid_signature(pset: &Pset, i: usize, key: &Key, value: u64) -> bool {
    let Some(raw) = pset.inputs()[i].partial_sigs.get(&key.pk) else { return false };
    let (sighash_byte, der) = raw.split_last().unwrap();
    let ty = EcdsaSighashType::from_u32(*sighash_byte as u32);
    let tx = pset.extract_tx().unwrap();
    let script_code = Script::new_p2pkh(&PubkeyHash::from_byte_array(key.pk.pubkey_hash().to_byte_array()));
    let sighash = SighashCache::new(&tx).segwitv0_sighash(i, &script_code, Value::Explicit(value), ty);
    let sig = Signature::from_der(der).unwrap();
    Secp256k1::verification_only()
        .verify_ecdsa(&Message::from_digest(sighash.to_byte_array()), &sig, &key.pk.inner)
        .is_ok()
}

#[test]
fn sign_adds_a_valid_signature_to_the_owned_input_and_leaves_the_foreign_input_unsigned() {
    let signed = parse(&sign(&b64(&transfer()), STARTER).unwrap());
    assert!(has_valid_signature(&signed, 0, &key(STARTER, 0, 0), 100_000));
    assert!(signed.inputs()[1].partial_sigs.is_empty());
}

#[test]
fn an_input_claiming_our_key_for_a_script_that_is_not_ours_stays_unsigned() {
    // Our fingerprint, path and pubkey, but the UTXO pays someone else's script.
    let mut pset = transfer();
    let ours = key(STARTER, 0, 0);
    pset.inputs_mut()[1].bip32_derivation.insert(ours.pk, (ours.fingerprint, ours.path.clone()));
    let signed = parse(&sign(&b64(&pset), STARTER).unwrap());
    assert!(signed.inputs()[1].partial_sigs.is_empty());
    assert!(has_valid_signature(&signed, 0, &ours, 100_000));
}

#[test]
fn an_input_whose_path_is_outside_the_account_stays_unsigned_even_though_it_re_derives() {
    // A key the Starter does hold, but at a path this Chain Module never hands out.
    let stray = key_at_path(STARTER, "m/44h/0h/0h/0/0");
    let mut pset = transfer();
    pset.inputs_mut()[1] = input(&stray, 50_000, 2);
    let signed = parse(&sign(&b64(&pset), STARTER).unwrap());
    assert!(signed.inputs()[1].partial_sigs.is_empty());
}

#[test]
fn a_foreign_starter_signs_nothing_of_ours() {
    let signed = parse(&sign(&b64(&transfer()), FOREIGN).unwrap());
    assert!(signed.inputs()[0].partial_sigs.is_empty());
    assert!(has_valid_signature(&signed, 1, &key(FOREIGN, 0, 0), 50_000));
}

#[test]
fn an_issuance_input_gets_a_valid_signature_that_commits_to_the_issuance() {
    let ours = key(STARTER, 0, 0);
    let signed = parse(&sign(&b64(&with_derivations(dex_issuance(), &ours)), STARTER).unwrap());
    assert!(has_valid_signature(&signed, 0, &ours, 100_000));

    // The sighash covers the issuance: change the amount and the signature no longer verifies.
    let mut tampered = signed.clone();
    tampered.inputs_mut()[0].issuance_value_amount = Some(2_000_000);
    assert!(!has_valid_signature(&tampered, 0, &ours, 100_000));
}

#[test]
fn the_dex_issuance_is_signed_from_the_address_alone_and_only_gains_the_signature() {
    use elements_miniscript::elements::encode::serialize;
    let unsigned = dex_issuance();
    let mut signed = parse(&sign(&b64(&unsigned), STARTER).unwrap());
    assert!(has_valid_signature(&signed, 0, &key(STARTER, 0, 0), 100_000));
    assert_eq!(signed.inputs()[0].partial_sigs.len(), 1);

    // The derivation the wallet worked out isn't written back.
    signed.inputs_mut()[0].partial_sigs.clear();
    assert_eq!(serialize(&signed), serialize(&unsigned));
}

#[test]
fn signing_keeps_unknown_pset_fields_byte_identical_and_only_adds_signatures() {
    use elements_miniscript::elements::encode::serialize;
    let unsigned = transfer_with_unknown_fields();
    let mut signed = parse(&sign(&b64(&unsigned), STARTER).unwrap());
    assert!(has_valid_signature(&signed, 0, &key(STARTER, 0, 0), 100_000));

    // Take the signatures back out: what remains is the request, byte for byte.
    for input in signed.inputs_mut() {
        input.partial_sigs.clear();
    }
    assert_eq!(serialize(&signed), serialize(&unsigned));
}
