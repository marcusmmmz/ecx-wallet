//! The wallet's own Send on eCash (#40), end to end inside the module: built from the account's
//! coins, decoded by the L1 Decoder, signed and finalized, replay-marked like every L1 spend.
mod common;

use std::str::FromStr;

use bitcoin::consensus::encode::deserialize_hex;
use bitcoin::psbt::Psbt;
use bitcoin::{Sequence, Transaction};
use common::{account_key, paying, receive_0, tx_hex};
use ecx_l1::{build_transfer, decode, derive_account, finalize, network, sign, ClearView, Decoded, Destination, RefusalCode};
use serde_json::json;

/// 1 sat/vB.
const FEE_RATE: u64 = 1000;

/// Someone else's P2WPKH address (BIP173's example).
const ELSEWHERE: &str = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";

/// The account's coin of `value` sats on its first receive address.
fn coin(seed: u8, value: u64) -> serde_json::Value {
    json!({ "tx": tx_hex(&paying(seed, &[(&receive_0(), value)])), "vout": 0, "chain": 0, "index": 0 })
}

fn to(address: &str, amount: u64) -> serde_json::Value {
    json!({ "asset": "", "amount": amount.to_string(), "to": { "address": address } })
}

fn order(outputs: Vec<serde_json::Value>, coins: Vec<serde_json::Value>) -> String {
    json!({ "coins": coins, "outputs": outputs, "feeRate": FEE_RATE, "changeIndex": 2 }).to_string()
}

fn built(order: &str) -> String {
    build_transfer(order, &account_key()).unwrap().pset
}

fn clear(psbt: &str) -> ClearView {
    match decode(psbt, &account_key()).unwrap() {
        Decoded::Clear { view } => view,
        blind => panic!("expected a Clear View, got {blind:?}"),
    }
}

fn change_2() -> String {
    derive_account(&account_key(), 0, 3).unwrap().change[2].address.clone()
}

#[test]
fn it_pays_each_output_in_order_then_change_to_the_given_change_address() {
    let built = build_transfer(&order(vec![to(ELSEWHERE, 30_000), to("1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2", 20_000)], vec![coin(1, 100_000)]), &account_key()).unwrap();
    let view = clear(&built.pset);
    let destinations: Vec<_> = view.outputs.iter().map(|o| (o.amount.clone(), o.destination.clone())).collect();
    assert_eq!(destinations[0], ("30000".into(), Destination::Address { address: ELSEWHERE.into(), yours: false }));
    assert_eq!(destinations[1], ("20000".into(), Destination::Address { address: "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2".into(), yours: false }));
    assert_eq!(destinations[2].1, Destination::Address { address: change_2(), yours: true });
    assert_eq!(view.inputs.len(), 1);
    assert!(view.inputs[0].yours);
    let fee: u64 = view.fee.amount.parse().unwrap();
    assert_eq!(100_000 - 30_000 - 20_000 - destinations[2].0.parse::<u64>().unwrap(), fee);

    let tx = &Psbt::from_str(&built.pset).unwrap().unsigned_tx;
    assert_eq!(built.spent.len(), 1);
    assert_eq!((built.spent[0].txid.clone(), built.spent[0].vout), (tx.input[0].previous_output.txid.to_string(), 0));
}

#[test]
fn it_is_replay_marked_and_replaceable() {
    let psbt = Psbt::from_str(&built(&order(vec![to(ELSEWHERE, 30_000)], vec![coin(1, 100_000)]))).unwrap();
    assert_eq!(psbt.unsigned_tx.lock_time.to_consensus_u32(), network().params.replay_lock_time);
    assert!(psbt.unsigned_tx.input.iter().all(|i| i.sequence == Sequence::ENABLE_RBF_NO_LOCKTIME));
}

#[test]
fn signed_and_finalized_it_is_a_complete_transaction() {
    let psbt = built(&order(vec![to(ELSEWHERE, 30_000)], vec![coin(1, 60_000), coin(2, 50_000)]));
    let finalized = finalize(&sign(&psbt, &account_key()).unwrap()).unwrap();
    let tx: Transaction = deserialize_hex(&finalized.tx).unwrap();
    assert_eq!(tx.compute_txid().to_string(), finalized.txid);
    assert!(tx.input.iter().all(|i| i.witness.len() == 2));
}

#[test]
fn coins_are_chosen_largest_first_and_only_as_many_as_needed() {
    let built = build_transfer(&order(vec![to(ELSEWHERE, 50_000)], vec![coin(1, 20_000), coin(2, 90_000), coin(3, 40_000)]), &account_key()).unwrap();
    let psbt = Psbt::from_str(&built.pset).unwrap();
    assert_eq!(psbt.inputs.len(), 1);
    assert_eq!(psbt.inputs[0].witness_utxo.as_ref().unwrap().value.to_sat(), 90_000);
    assert_eq!(built.spent.len(), 1);
}

#[test]
fn the_fee_pays_at_least_the_rate_for_the_signed_size() {
    let psbt = built(&order(vec![to(ELSEWHERE, 30_000)], vec![coin(1, 100_000)]));
    let fee: u64 = clear(&psbt).fee.amount.parse().unwrap();
    let tx: Transaction = deserialize_hex(&finalize(&sign(&psbt, &account_key()).unwrap()).unwrap().tx).unwrap();
    assert!(fee >= tx.vsize() as u64 * FEE_RATE / 1000, "fee {fee} for {} vB", tx.vsize());
}

#[test]
fn change_below_dust_goes_to_the_fee() {
    // 50,000 in, 49,700 out: what's left is below P2WPKH's 294 once the fee is paid.
    let view = clear(&built(&order(vec![to(ELSEWHERE, 49_700)], vec![coin(1, 50_000)])));
    assert_eq!(view.outputs.len(), 1, "no change output");
    assert_eq!(view.fee.amount, "300");
}

#[test]
fn every_address_kind_bitcoin_defines_is_paid() {
    for address in [
        ELSEWHERE,
        "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2",
        "3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy",
        "bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3",
        "bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr",
    ] {
        let view = clear(&built(&order(vec![to(address, 10_000)], vec![coin(1, 100_000)])));
        assert_eq!(view.outputs[0].destination, Destination::Address { address: address.into(), yours: false }, "{address}");
    }
}

#[test]
fn an_address_it_cant_pay_is_refused() {
    for address in [
        // A segwit version eCash doesn't define: anyone could spend it.
        "bc1zw508d6qejxtdg4y5r3zarvaryvaxxpcs",
        // Testnet's encoding, and not an address at all.
        "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx",
        "not an address",
    ] {
        if address.starts_with("bc1z") {
            assert!(bitcoin::bech32::segwit::decode(address).is_ok(), "BIP350's valid v2 vector");
        }
        let error = build_transfer(&order(vec![to(address, 10_000)], vec![coin(1, 100_000)]), &account_key()).unwrap_err();
        assert_eq!(error.code, RefusalCode::Malformed, "{address}");
        assert!(error.message.contains("isn't an eCash address"), "{address}: {}", error.message);
    }
}

#[test]
fn a_payment_below_dust_is_refused() {
    for (address, dust) in [(ELSEWHERE, 294), ("1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2", 546)] {
        build_transfer(&order(vec![to(address, dust)], vec![coin(1, 100_000)]), &account_key()).unwrap();
        let error = build_transfer(&order(vec![to(address, dust - 1)], vec![coin(1, 100_000)]), &account_key()).unwrap_err();
        assert_eq!(error.code, RefusalCode::Dust, "{address}");
    }
}

#[test]
fn not_enough_coins_is_a_refusal_that_says_what_is_needed() {
    let error = build_transfer(&order(vec![to(ELSEWHERE, 50_000)], vec![coin(1, 30_000), coin(2, 20_000)]), &account_key()).unwrap_err();
    assert_eq!(error.code, RefusalCode::InsufficientFunds);
    assert!(error.message.contains("the wallet can spend 0.00050000 ECX"), "{}", error.message);
}

#[test]
fn an_asset_a_coin_twice_or_a_coin_not_the_accounts_is_refused() {
    let asset = json!({ "asset": "aa".repeat(32), "amount": "1000", "to": { "address": ELSEWHERE } });
    assert_eq!(build_transfer(&order(vec![asset], vec![coin(1, 100_000)]), &account_key()).unwrap_err().code, RefusalCode::Malformed);

    let error = build_transfer(&order(vec![to(ELSEWHERE, 1_000)], vec![coin(1, 100_000), coin(1, 100_000)]), &account_key()).unwrap_err();
    assert!(error.message.contains("listed twice"), "{}", error.message);

    let foreign = json!({ "tx": tx_hex(&paying(9, &[(&receive_0(), 100_000)])), "vout": 0, "chain": 1, "index": 0 });
    let error = build_transfer(&order(vec![to(ELSEWHERE, 1_000)], vec![foreign]), &account_key()).unwrap_err();
    assert!(error.message.contains("doesn't pay this account"), "{}", error.message);
}

#[test]
fn a_psbt_with_no_input_of_the_accounts_has_nothing_to_sign() {
    let mut psbt = Psbt::from_str(&built(&order(vec![to(ELSEWHERE, 30_000)], vec![coin(1, 100_000)]))).unwrap();
    psbt.inputs[0].bip32_derivation.clear();
    let error = sign(&psbt.to_string(), &account_key()).unwrap_err();
    assert_eq!(error.code, RefusalCode::NothingToSign);
}
