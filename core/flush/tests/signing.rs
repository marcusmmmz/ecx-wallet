//! Requests from apps: what the Flush Decoder shows, which inputs `sign` signs, and what both
//! refuse. Ownership is proven by re-deriving, or by the script of the address apps are given
//! (docs/adr/0007).
mod common;

use std::str::FromStr;

use bitcoin::absolute::LockTime;
use bitcoin::bip32::{DerivationPath, Fingerprint};
use bitcoin::psbt::{Input, Psbt};
use bitcoin::script::PushBytesBuf;
use bitcoin::transaction::Version;
use bitcoin::{Amount, OutPoint, ScriptBuf, Sequence, Transaction, TxIn, TxOut, Witness};
use common::{paying, script, FOREIGN, STARTER};
use ecx_flush::{check, decode, derive_account, finalize, sign, Decoded, Destination, RefusalCode};

/// An input spending `prev`'s output 0, with `derivation` as its `bip32_derivation`.
struct Spend {
    prev: Transaction,
    derivation: Option<(String, String)>,
}

/// The Starter's coin of `value` on receive `index`, named by its derivation or not.
fn ours(seed: u8, value: u64, index: u32, named: bool) -> Spend {
    let derivation = named.then(|| (derive_account(STARTER, index + 1, 0).unwrap().receive[index as usize].public_key.clone(), format!("m/84'/1'/0'/0/{index}")));
    Spend { prev: paying(seed, &[(&script(STARTER, 0, index), value)]), derivation }
}

fn foreign(seed: u8, value: u64) -> Spend {
    Spend { prev: paying(seed, &[(&script(FOREIGN, 0, 0), value)]), derivation: None }
}

fn request(spends: &[Spend], outputs: Vec<TxOut>, lock_time: u32, sequence: Sequence) -> Psbt {
    let fingerprint = Fingerprint::from_str(&derive_account(STARTER, 0, 0).unwrap().descriptor[6..14]).unwrap();
    let tx = Transaction {
        version: Version::TWO,
        lock_time: LockTime::from_consensus(lock_time),
        input: spends.iter().map(|s| TxIn { previous_output: OutPoint { txid: s.prev.compute_txid(), vout: 0 }, script_sig: ScriptBuf::new(), sequence, witness: Witness::new() }).collect(),
        output: outputs,
    };
    let mut psbt = Psbt::from_unsigned_tx(tx).unwrap();
    for (input, spend) in psbt.inputs.iter_mut().zip(spends) {
        *input = Input { non_witness_utxo: Some(spend.prev.clone()), ..Input::default() };
        if let Some((pubkey, path)) = &spend.derivation {
            input.bip32_derivation.insert(bitcoin::secp256k1::PublicKey::from_str(pubkey).unwrap(), (fingerprint, DerivationPath::from_str(path).unwrap()));
        }
    }
    psbt
}

fn pay(to: ScriptBuf, value: u64) -> TxOut {
    TxOut { value: Amount::from_sat(value), script_pubkey: to }
}

fn op_return(data: &[u8]) -> TxOut {
    pay(ScriptBuf::new_op_return(PushBytesBuf::try_from(data.to_vec()).unwrap()), 0)
}

fn plain(spends: &[Spend]) -> Psbt {
    request(spends, vec![pay(script(FOREIGN, 0, 1), 50_000)], 0, Sequence::ENABLE_RBF_NO_LOCKTIME)
}

fn signed_inputs(psbt: &Psbt) -> Vec<usize> {
    let signed = Psbt::from_str(&sign(&psbt.to_string(), STARTER).unwrap()).unwrap();
    (0..signed.inputs.len()).filter(|i| !signed.inputs[*i].partial_sigs.is_empty()).collect()
}

#[test]
fn signs_only_the_inputs_that_re_derive_and_nothing_else_changes() {
    let psbt = plain(&[ours(1, 40_000, 0, true), foreign(2, 30_000), ours(3, 20_000, 1, true)]);
    assert_eq!(signed_inputs(&psbt), [0, 2]);
    let mut signed = Psbt::from_str(&sign(&psbt.to_string(), STARTER).unwrap()).unwrap();
    for input in &mut signed.inputs {
        input.partial_sigs.clear();
    }
    assert_eq!(signed, psbt, "the PSBT differs from the request by signatures only");
}

#[test]
fn the_given_out_address_needs_no_derivation_but_other_addresses_do() {
    // Receive 0 is what getAddresses gives apps; receive 1 must be named.
    assert_eq!(signed_inputs(&plain(&[ours(1, 40_000, 0, false), ours(2, 40_000, 1, false), ours(3, 40_000, 1, true)])), [0, 2]);
}

#[test]
fn a_request_with_nothing_of_this_wallets_is_refused() {
    let psbt = plain(&[foreign(1, 100_000), ours(2, 40_000, 1, false)]);
    assert_eq!(decode(&psbt.to_string(), STARTER).unwrap_err().code, RefusalCode::NothingToSign);
    assert_eq!(sign(&psbt.to_string(), STARTER).unwrap_err().code, RefusalCode::NothingToSign);
}

#[test]
fn an_input_that_claims_our_fingerprint_without_re_deriving_is_never_signed() {
    let mut forged = ours(2, 40_000, 0, true);
    forged.prev = paying(2, &[(&script(FOREIGN, 0, 0), 40_000)]);
    let psbt = plain(&[ours(1, 40_000, 0, true), forged]);
    assert_eq!(signed_inputs(&psbt), [0]);
    let Decoded::Blind { verifiable_facts, .. } = decode(&psbt.to_string(), STARTER).unwrap() else { panic!("an unproven claim can't be Clear") };
    assert!(verifiable_facts.dangerous_flags[0].contains("input 1 claims one of this wallet's keys"));
}

#[test]
fn no_replay_marker_is_asked_for_or_refused() {
    // L1 refuses the first and requires the second; Flush has its own genesis (docs/adr/0011).
    for (lock_time, sequence) in [(0, Sequence::MAX), (499_999_999, Sequence::ENABLE_RBF_NO_LOCKTIME)] {
        let psbt = request(&[ours(1, 100_000, 0, true)], vec![pay(script(FOREIGN, 0, 1), 50_000)], lock_time, sequence);
        assert_eq!(signed_inputs(&psbt), [0]);
    }
}

#[test]
fn a_plain_payment_is_clear_with_its_fee_from_the_previous_transactions() {
    let psbt = request(
        &[ours(1, 100_000, 0, true), foreign(2, 10_000)],
        vec![pay(script(FOREIGN, 0, 1), 50_000), pay(script(STARTER, 0, 0), 59_000)],
        0,
        Sequence::ENABLE_RBF_NO_LOCKTIME,
    );
    let Decoded::Clear { view } = decode(&psbt.to_string(), STARTER).unwrap() else { panic!("a plain payment is Clear") };
    assert_eq!(view.fee.amount, "1000");
    assert_eq!((view.inputs[0].yours, view.inputs[1].yours), (true, false));
    let Destination::Address { address, yours } = &view.outputs[1].destination;
    assert!(address.starts_with("bflx1q") && *yours, "the given-out address is yours without a derivation");
}

#[test]
fn every_flush_operation_is_blind_and_named() {
    // A ClaimLaunch (kind 23) of token ab…ab, listing no outputs.
    let claim = [&b"BAST\x00\x17"[..], &[0xab; 32], &[0]].concat();
    let cases: [(&[u8], &str); 4] = [
        (&claim, "a Flush claim launch"),
        (b"\xDBSTK", "a stake bond"),
        (b"\xD8WDR", "a withdrawal to eCash"),
        (b"something else", "OP_RETURN"),
    ];
    for (data, named) in cases {
        let psbt = request(&[ours(1, 100_000, 0, true)], vec![pay(script(FOREIGN, 0, 1), 50_000), op_return(data)], 0, Sequence::ENABLE_RBF_NO_LOCKTIME);
        let Decoded::Blind { reason, verifiable_facts } = decode(&psbt.to_string(), STARTER).unwrap() else { panic!("{named} must be Blind") };
        assert!(reason.contains(named), "{named}: {reason}");
        assert_eq!(verifiable_facts.total_leaving[0].amount, "100000");
        assert_eq!(verifiable_facts.fee[0].amount, "50000");
    }
}

#[test]
fn a_bast_marker_flush_couldnt_read_is_refused_before_unlock() {
    // A LaunchToken with params (kind 36), cut short: the node would refuse the transaction.
    let psbt = request(&[ours(1, 100_000, 0, true)], vec![pay(script(FOREIGN, 0, 1), 50_000), op_return(b"BAST\x00\x24")], 0, Sequence::ENABLE_RBF_NO_LOCKTIME);
    let refusal = check(&psbt.to_string()).unwrap_err();
    assert_eq!(refusal.code, RefusalCode::Malformed);
    assert!(refusal.message.contains("doesn't parse"), "{}", refusal.message);
    assert_eq!(sign(&psbt.to_string(), STARTER).unwrap_err().code, RefusalCode::Malformed);
}

#[test]
fn an_input_without_its_previous_transaction_is_refused_before_unlock() {
    let mut psbt = plain(&[ours(1, 100_000, 0, true)]);
    psbt.inputs[0].non_witness_utxo = None;
    psbt.inputs[0].witness_utxo = Some(pay(script(STARTER, 0, 0), 100_000));
    assert_eq!(check(&psbt.to_string()).unwrap_err().code, RefusalCode::MissingInputFields);
}

#[test]
fn a_previous_transaction_that_isnt_the_one_spent_is_refused() {
    let mut psbt = plain(&[ours(1, 100_000, 0, true)]);
    psbt.inputs[0].non_witness_utxo = Some(paying(9, &[(&script(STARTER, 0, 0), 900_000)]));
    assert_eq!(check(&psbt.to_string()).unwrap_err().code, RefusalCode::Malformed);
}

#[test]
fn another_wallets_starter_signs_nothing_and_a_non_starter_is_refused() {
    let psbt = plain(&[ours(1, 100_000, 0, true)]);
    assert_eq!(sign(&psbt.to_string(), FOREIGN).unwrap_err().code, RefusalCode::NothingToSign);
    assert_eq!(sign(&psbt.to_string(), "[73c5da0a/84h/0h/0h]xprv").unwrap_err().code, RefusalCode::InvalidStarter);
}

#[test]
fn finalize_needs_a_valid_signature_on_every_input() {
    let psbt = plain(&[ours(1, 100_000, 0, true), foreign(2, 10_000)]);
    let signed = sign(&psbt.to_string(), STARTER).unwrap();
    assert!(finalize(&signed).unwrap_err().message.contains("Input 1 isn't signed"));

    let mut tampered = Psbt::from_str(&sign(&plain(&[ours(1, 100_000, 0, true)]).to_string(), STARTER).unwrap()).unwrap();
    tampered.unsigned_tx.output[0].value = Amount::from_sat(60_000);
    assert!(finalize(&tampered.to_string()).unwrap_err().message.contains("signature isn't valid"));
}
