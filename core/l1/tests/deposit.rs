//! Deposits (M5s) end to end inside the module: built from the account's coins, decoded by the L1
//! Decoder, signed, and finalized; and the v0 invariant that nothing without the replay marker is
//! ever signed (docs/adr/0004).
mod common;

use std::str::FromStr;

use bitcoin::consensus::encode::deserialize_hex;
use bitcoin::psbt::Psbt;
use bitcoin::{ScriptBuf, Sequence, Transaction};
use common::{account_key, paying, receive_0, treasury_24, tx_hex};
use ecx_l1::{build_deposit, check, derive_account, decode, finalize, sign, ClearView, DangerousMode, Decoded, Destination, RefusalCode};
use serde_json::json;

/// What Slot 24's Chain Module encodes a destination as: the Elements address, as UTF-8.
const ELEMENTS_ADDRESS: &str = "elements1qew44aehkjstjm56ng2rjrz57vwxh5g9su6dlpm";

/// 1 sat/vB.
const FEE_RATE: u64 = 1000;

fn destination() -> String {
    ELEMENTS_ADDRESS.bytes().map(|b| format!("{b:02x}")).collect()
}

/// The account's coin of `value` sats on its first receive address.
fn coin(seed: u8, value: u64) -> serde_json::Value {
    json!({ "tx": tx_hex(&paying(seed, &[(&receive_0(), value)])), "vout": 0, "chain": 0, "index": 0 })
}

/// Slot 24's Treasury holding `value`, created by an M5.
fn treasury(value: u64) -> (Transaction, serde_json::Value) {
    let data = ScriptBuf::new_op_return(<&bitcoin::script::PushBytes>::try_from(ELEMENTS_ADDRESS.as_bytes()).unwrap());
    let tx = paying(0xee, &[(&treasury_24(), value), (&data, 0)]);
    let prev = json!({ "tx": tx_hex(&tx), "vout": 0 });
    (tx, prev)
}

fn order(amount: u64, coins: Vec<serde_json::Value>, treasury: Option<serde_json::Value>) -> String {
    json!({
        "slot": 24, "amount": amount.to_string(), "destination": destination(), "feeRate": FEE_RATE,
        "coins": coins, "treasury": treasury, "changeIndex": 3,
    })
    .to_string()
}

fn built(order: &str) -> String {
    build_deposit(order, &account_key()).unwrap().psbt
}

fn clear(psbt: &str) -> ClearView {
    match decode(psbt, &account_key()).unwrap() {
        Decoded::Clear { view } => view,
        blind => panic!("expected a Clear View, got {blind:?}"),
    }
}

#[test]
fn an_m5_spends_the_treasury_and_recreates_it_grown_by_the_amount_followed_by_its_address() {
    let (treasury_tx, prev) = treasury(100_000);
    let psbt = Psbt::from_str(&built(&order(50_000, vec![coin(1, 250_000)], Some(prev)))).unwrap();
    let tx = &psbt.unsigned_tx;

    assert_eq!(tx.lock_time.to_consensus_u32(), 499_999_999, "the replay marker");
    assert!(tx.input.iter().all(|input| input.sequence == Sequence::ENABLE_RBF_NO_LOCKTIME), "non-final nSequence everywhere");
    assert_eq!(tx.input[0].previous_output.txid, treasury_tx.compute_txid(), "the Treasury is spent first");
    assert_eq!(psbt.inputs[0].final_script_sig, Some(ScriptBuf::new()), "with an empty scriptSig");

    assert_eq!(tx.output[0].script_pubkey, treasury_24());
    assert_eq!(tx.output[0].value.to_sat(), 150_000, "the old Treasury plus the deposit");
    assert_eq!(ELEMENTS_ADDRESS.len(), 0x30);
    assert_eq!(tx.output[1].script_pubkey.to_hex_string(), format!("6a30{}", destination()), "OP_RETURN <48-byte address>");
    assert_eq!(tx.output[1].value.to_sat(), 0);
    assert_eq!(tx.output.len(), 3, "and change");
}

#[test]
fn the_decoder_shows_the_deposit_the_treasury_input_and_the_change_as_yours() {
    let (_, prev) = treasury(100_000);
    let view = clear(&built(&order(50_000, vec![coin(1, 250_000)], Some(prev))));

    assert_eq!(view.dangerous_modes, [DangerousMode::Deposit { output: 0 }], "a Deposit, not a first one");
    assert_eq!(view.inputs.len(), 2);
    assert_eq!((view.inputs[0].treasury, view.inputs[0].yours, view.inputs[0].amount.as_str()), (Some(24), false, "100000"));
    assert_eq!((view.inputs[1].treasury, view.inputs[1].yours, view.inputs[1].amount.as_str()), (None, true, "250000"));

    assert_eq!(view.outputs.len(), 2, "the address output is part of the Deposit");
    match &view.outputs[0].destination {
        Destination::Deposit { slot, deposit, treasury_before, data_output, text, .. } => {
            assert_eq!((*slot, deposit.as_str(), treasury_before.as_str(), *data_output), (24, "50000", "100000", 1));
            assert_eq!(text.as_deref(), Some(ELEMENTS_ADDRESS));
        }
        other => panic!("expected a Deposit, got {other:?}"),
    }
    let Destination::Address { address, yours } = &view.outputs[1].destination else { panic!("change is an address") };
    assert_eq!(*address, derive_account(&account_key(), 0, 4).unwrap().change[3].address, "m/84'/0'/0'/1/3, the change index asked for");
    assert!(*yours);

    let change: u64 = view.outputs[1].amount.parse().unwrap();
    let fee: u64 = view.fee.amount.parse().unwrap();
    assert_eq!(change + fee, 200_000, "what's left of the coin after the deposit");
}

#[test]
fn the_fee_pays_at_least_the_rate_for_the_signed_size() {
    let (_, prev) = treasury(100_000);
    let psbt = built(&order(50_000, vec![coin(1, 250_000)], Some(prev)));
    let fee: u64 = clear(&psbt).fee.amount.parse().unwrap();
    let tx: Transaction = deserialize_hex(&finalize(&sign(&psbt, &account_key()).unwrap()).unwrap().tx).unwrap();
    let vsize = tx.weight().to_wu().div_ceil(4);
    assert!(fee >= vsize, "{fee} sats for {vsize} vB at 1 sat/vB");
    assert!(fee <= vsize + 2, "the estimate is the signed size, give or take a signature byte");
}

#[test]
fn a_first_deposit_spends_no_treasury_and_is_flagged() {
    let psbt = built(&order(50_000, vec![coin(1, 250_000)], None));
    let view = clear(&psbt);
    assert_eq!(view.dangerous_modes, [DangerousMode::Deposit { output: 0 }, DangerousMode::FirstDeposit { output: 0 }]);
    assert!(view.inputs.iter().all(|input| input.treasury.is_none()));
    let Destination::Deposit { deposit, treasury_before, .. } = &view.outputs[0].destination else { panic!() };
    assert_eq!((deposit.as_str(), treasury_before.as_str()), ("50000", "0"));
    assert_eq!(view.outputs[0].amount, "50000");
}

#[test]
fn signed_and_finalized_it_is_a_complete_replay_marked_transaction() {
    let (_, prev) = treasury(100_000);
    let psbt = built(&order(50_000, vec![coin(1, 250_000)], Some(prev)));
    let signed = sign(&psbt, &account_key()).unwrap();
    let finalized = finalize(&signed).unwrap();
    let tx: Transaction = deserialize_hex(&finalized.tx).unwrap();
    assert_eq!(tx.compute_txid().to_string(), finalized.txid);
    assert_eq!(tx.lock_time.to_consensus_u32(), 499_999_999);
    assert!(tx.input[0].script_sig.is_empty() && tx.input[0].witness.is_empty(), "the Treasury needs nothing");
    assert_eq!(tx.input[1].witness.len(), 2, "signature and public key");
    assert_eq!(tx.output[0].value.to_sat(), 150_000);
}

#[test]
fn finalize_refuses_an_unsigned_or_tampered_psbt() {
    let psbt = built(&order(50_000, vec![coin(1, 250_000)], None));
    assert_eq!(finalize(&psbt).unwrap_err().code, RefusalCode::Malformed, "unsigned");

    let mut signed = Psbt::from_str(&sign(&psbt, &account_key()).unwrap()).unwrap();
    signed.unsigned_tx.output[0].value = bitcoin::Amount::from_sat(40_000);
    let error = finalize(&signed.to_string()).unwrap_err();
    assert!(error.message.contains("signature isn't valid"), "{}", error.message);
}

#[test]
fn txid_hashes_a_raw_transaction() {
    let tx = paying(1, &[(&receive_0(), 1_000)]);
    assert_eq!(ecx_l1::txid(&tx_hex(&tx)).unwrap(), tx.compute_txid().to_string());
    assert!(ecx_l1::txid("00").is_err());
}

#[test]
fn coins_are_chosen_largest_first_and_only_as_many_as_needed() {
    let psbt = Psbt::from_str(&built(&order(50_000, vec![coin(1, 20_000), coin(2, 90_000), coin(3, 40_000)], None))).unwrap();
    assert_eq!(psbt.unsigned_tx.input.len(), 1);
    assert_eq!(psbt.inputs[0].witness_utxo.as_ref().unwrap().value.to_sat(), 90_000);
}

#[test]
fn change_too_small_to_pay_goes_to_the_fee() {
    let view = clear(&built(&order(49_700, vec![coin(1, 50_000)], None)));
    assert_eq!(view.outputs.len(), 1, "no change output");
    assert_eq!(view.fee.amount, "300");
}

#[test]
fn not_enough_confirmed_coins_is_a_refusal_that_says_what_is_needed() {
    let error = build_deposit(&order(50_000, vec![coin(1, 30_000), coin(2, 20_000)], None), &account_key()).unwrap_err();
    assert_eq!(error.code, RefusalCode::InsufficientFunds);
    assert!(error.message.contains("the wallet has 50000"), "{}", error.message);
}

#[test]
fn a_coin_that_doesnt_pay_the_account_or_a_treasury_that_isnt_one_is_refused() {
    let foreign = json!({ "tx": tx_hex(&paying(9, &[(&treasury_24(), 250_000)])), "vout": 0, "chain": 0, "index": 0 });
    let error = build_deposit(&order(50_000, vec![foreign], None), &account_key()).unwrap_err();
    assert!(error.message.contains("doesn't pay this account"), "{}", error.message);

    let not_a_treasury = json!({ "tx": tx_hex(&paying(8, &[(&receive_0(), 1_000)])), "vout": 0 });
    let error = build_deposit(&order(50_000, vec![coin(1, 250_000)], Some(not_a_treasury)), &account_key()).unwrap_err();
    assert!(error.message.contains("Treasury script"), "{}", error.message);
}

#[test]
fn nothing_without_the_replay_marker_is_checked_decoded_or_signed() {
    let built = Psbt::from_str(&built(&order(50_000, vec![coin(1, 250_000)], None))).unwrap();

    let mut no_locktime = built.clone();
    no_locktime.unsigned_tx.lock_time = bitcoin::absolute::LockTime::ZERO;
    let mut final_sequence = built.clone();
    final_sequence.unsigned_tx.input[0].sequence = Sequence::MAX;

    for unmarked in [no_locktime, final_sequence] {
        let payload = unmarked.to_string();
        assert_eq!(check(&payload).unwrap_err().code, RefusalCode::NoReplayMarker);
        assert_eq!(decode(&payload, &account_key()).unwrap_err().code, RefusalCode::NoReplayMarker);
        assert_eq!(sign(&payload, &account_key()).unwrap_err().code, RefusalCode::NoReplayMarker);
        assert_eq!(finalize(&payload).unwrap_err().code, RefusalCode::NoReplayMarker);
    }
}

#[test]
fn every_input_must_carry_the_transaction_it_spends() {
    let built = Psbt::from_str(&built(&order(50_000, vec![coin(1, 250_000)], None))).unwrap();

    let mut missing = built.clone();
    missing.inputs[0].non_witness_utxo = None;
    assert_eq!(check(&missing.to_string()).unwrap_err().code, RefusalCode::MissingInputFields);

    // Another transaction than the input names: its values could be anything.
    let mut swapped = built.clone();
    swapped.inputs[0].non_witness_utxo = Some(paying(1, &[(&receive_0(), 900_000)]));
    swapped.inputs[0].witness_utxo = None;
    let error = check(&swapped.to_string()).unwrap_err();
    assert_eq!(error.code, RefusalCode::Malformed);
    assert!(error.message.contains("isn't the transaction it spends"), "{}", error.message);
}

#[test]
fn what_the_decoder_cant_fully_explain_is_blind() {
    let (_, prev) = treasury(100_000);
    let built = Psbt::from_str(&built(&order(50_000, vec![coin(1, 250_000)], Some(prev)))).unwrap();
    let blind = |psbt: &Psbt| match decode(&psbt.to_string(), &account_key()).unwrap() {
        Decoded::Blind { reason, .. } => reason,
        Decoded::Clear { .. } => panic!("expected Blind"),
    };

    // The Treasury spent, but no Treasury recreated: the Slot's funds drained.
    let mut drained = built.clone();
    drained.unsigned_tx.output.drain(..2);
    drained.outputs.drain(..2);
    assert!(blind(&drained).contains("spends Slot 24's Treasury without recreating it"), "{}", blind(&drained));

    // Another OP_RETURN than a Deposit's address.
    let mut stray = built.clone();
    stray.unsigned_tx.output[0].script_pubkey = receive_0();
    assert!(blind(&stray).contains("output 1 is an OP_RETURN that isn't a deposit address"), "{}", blind(&stray));

    // A Treasury output that shrinks: an M6's shape, never a Deposit.
    let mut shrinking = built.clone();
    shrinking.unsigned_tx.output[0].value = bitcoin::Amount::from_sat(90_000);
    assert!(blind(&shrinking).contains("doesn't grow Slot 24's Treasury"), "{}", blind(&shrinking));

    // No address after the Treasury output.
    let mut no_address = built.clone();
    no_address.unsigned_tx.output.swap(1, 2);
    no_address.outputs.swap(1, 2);
    assert!(blind(&no_address).contains("no deposit address follows it"), "{}", blind(&no_address));
}

#[test]
fn a_deposit_on_an_unconfirmed_treasury_stays_within_what_ecash_relays_for_one() {
    // Backbone refuses an M5 over 1,000 vB that spends an unconfirmed Treasury (`dc-unconfirmed-parent`).
    let small: Vec<_> = (1..=30).map(|seed| coin(seed, 1_000)).collect();
    let (_, mut prev) = treasury(500_000);
    prev["unconfirmed"] = json!(true);
    let error = build_deposit(&order(20_000, small.clone(), Some(prev)), &account_key()).unwrap_err();
    assert_eq!(error.code, RefusalCode::TooLarge);
    assert!(error.message.contains("eCash relays at most 1000 vB for a Deposit that spends an unconfirmed Treasury"), "{}", error.message);
    // A confirmed Treasury allows up to 10,000 vB: the same Deposit builds.
    let (_, prev) = treasury(500_000);
    assert!(build_deposit(&order(20_000, small, Some(prev)), &account_key()).is_ok());
}

#[test]
fn a_destination_longer_than_backbones_100_bytes_is_refused() {
    let mut long = serde_json::from_str::<serde_json::Value>(&order(50_000, vec![coin(1, 90_000)], None)).unwrap();
    long["destination"] = json!("61".repeat(101));
    let error = build_deposit(&long.to_string(), &account_key()).unwrap_err();
    assert!(error.message.contains("1 to 100 bytes"), "{}", error.message);
}
