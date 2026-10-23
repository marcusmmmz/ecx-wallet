//! Seam 2: `build_transfer(order, starter)` and `finalize(payload)` through the Chain Module's
//! public interface. What a built transfer does is read back through the module's own Decoder.
mod common;

use common::*;
use ecx_elements::{build_transfer, decode, finalize, network, sign, ClearView, Decoded, Destination, RefusalCode};
use elements_miniscript::elements::encode::deserialize;
use elements_miniscript::elements::{Address, AddressParams, AssetId, Transaction};
use serde_json::{json, Value};

const POLICY: &str = "5836dcc06130dcf6a65b6ac493813fd65559955283e44cc3f07966294eccb2c8";
/// 0.1 sat/vB, Liquid's floor.
const RATE: u64 = 100;

fn other_asset() -> String {
    AssetId::from_slice(&[7; 32]).unwrap().to_string()
}

fn coin(n: u8, asset: &str, value: u64, chain: u32, index: u32) -> Value {
    json!({ "txid": format!("{n:02x}").repeat(32), "vout": 0, "asset": asset, "value": value.to_string(), "chain": chain, "index": index })
}

fn pay(asset: &str, amount: u64, address: &str) -> Value {
    json!({ "asset": asset, "amount": amount.to_string(), "to": { "address": address } })
}

fn order(coins: Vec<Value>, outputs: Vec<Value>) -> String {
    json!({ "coins": coins, "outputs": outputs, "feeRate": RATE, "changeIndex": 3 }).to_string()
}

fn foreign() -> String {
    address(FOREIGN, 0, 1)
}

fn build(order: &str) -> String {
    build_transfer(order, STARTER).unwrap().pset
}

fn clear(payload: &str) -> ClearView {
    match decode(payload, STARTER).unwrap() {
        Decoded::Clear { view } => view,
        blind => panic!("expected a Clear View, got {blind:?}"),
    }
}

fn refusal(order: &str) -> (RefusalCode, String) {
    let r = build_transfer(order, STARTER).unwrap_err();
    (r.code, r.message)
}

/// The outputs as (asset, amount, address, yours), fee left out.
fn rows(view: &ClearView) -> Vec<(String, u64, String, bool)> {
    view.outputs
        .iter()
        .map(|o| match &o.destination {
            Destination::Address { address, yours } => (o.asset.clone(), o.amount.parse().unwrap(), address.clone(), *yours),
            other => panic!("unexpected destination {other:?}"),
        })
        .collect()
}

fn signed_tx(payload: &str) -> (Transaction, String) {
    let finalized = finalize(&sign(payload, STARTER).unwrap()).unwrap();
    let bytes = hex_bytes(&finalized.tx);
    (deserialize(&bytes).unwrap(), finalized.txid)
}

#[test]
fn a_send_pays_the_destination_returns_change_to_the_given_change_address_and_pays_a_fee_at_the_rate() {
    let payload = build(&order(vec![coin(1, POLICY, 100_000, 0, 0)], vec![pay(POLICY, 60_000, &foreign())]));
    let view = clear(&payload);
    let fee: u64 = view.fee.amount.parse().unwrap();
    assert_eq!(rows(&view), [(POLICY.into(), 60_000, foreign(), false), (POLICY.into(), 40_000 - fee, address(STARTER, 1, 3), true)]);
    assert!(view.inputs.iter().all(|i| i.yours));

    // The fee covers the signed transaction at the rate, and overestimates it by little.
    let (tx, _) = signed_tx(&payload);
    let vsize = tx.vsize() as u64;
    assert!(fee * 1000 >= vsize * RATE, "fee {fee} for {vsize} vB");
    assert!(fee <= (vsize + 2) * RATE / 1000 + 1, "fee {fee} for {vsize} vB");
}

#[test]
fn coins_are_spent_largest_first_and_only_as_many_as_needed() {
    let coins = vec![coin(1, POLICY, 10_000, 0, 0), coin(2, POLICY, 90_000, 0, 1), coin(3, POLICY, 50_000, 1, 0)];
    let built = build_transfer(&order(coins, vec![pay(POLICY, 60_000, &foreign())]), STARTER).unwrap();
    let spent: Vec<_> = clear(&built.pset).inputs.iter().map(|i| i.amount.clone()).collect();
    assert_eq!(spent, ["90000"]);
    assert_eq!(built.spent.iter().map(|s| (s.txid.as_str(), s.vout)).collect::<Vec<_>>(), [("02".repeat(32).as_str(), 0)]);
}

#[test]
fn several_recipients_and_assets_go_in_one_transaction_with_change_per_asset() {
    let other = other_asset();
    let coins = vec![coin(1, POLICY, 100_000, 0, 0), coin(2, &other, 500, 0, 1)];
    let outputs = vec![pay(POLICY, 20_000, &foreign()), pay(&other, 200, &address(FOREIGN, 0, 2)), pay(POLICY, 30_000, &address(FOREIGN, 0, 3))];
    let view = clear(&build(&order(coins, outputs)));
    let fee: u64 = view.fee.amount.parse().unwrap();
    assert_eq!(view.fee.asset, POLICY);
    let change = address(STARTER, 1, 3);
    assert_eq!(
        rows(&view),
        [
            (POLICY.into(), 20_000, foreign(), false),
            (other.clone(), 200, address(FOREIGN, 0, 2), false),
            (POLICY.into(), 30_000, address(FOREIGN, 0, 3), false),
            (other, 300, change.clone(), true),
            (POLICY.into(), 50_000 - fee, change, true),
        ]
    );
}

#[test]
fn sending_another_asset_still_needs_the_policy_asset_for_the_fee() {
    let other = other_asset();
    let (code, message) = refusal(&order(vec![coin(2, &other, 500, 0, 1)], vec![pay(&other, 500, &foreign())]));
    assert_eq!(code, RefusalCode::InsufficientFunds);
    assert!(message.starts_with("Not enough ECX to pay the fee"), "{message}");
}

#[test]
fn enough_for_the_payment_but_not_its_fee_says_the_fee_is_short() {
    let (code, message) = refusal(&order(vec![coin(1, POLICY, 5_000, 0, 0)], vec![pay(POLICY, 5_000, &foreign())]));
    assert_eq!(code, RefusalCode::InsufficientFunds);
    assert!(message.starts_with("Not enough ECX to pay the fee: this needs 0.0000"), "{message}");
    assert!(message.ends_with("with its fee, and the wallet can spend 0.00005000 ECX."), "{message}");
}

#[test]
fn too_little_of_an_asset_is_refused_with_what_it_needs_and_what_the_wallet_has() {
    let (code, message) = refusal(&order(vec![coin(1, POLICY, 1_000, 0, 0)], vec![pay(POLICY, 5_000, &foreign())]));
    assert_eq!(code, RefusalCode::InsufficientFunds);
    assert!(message.starts_with("Not enough ECX: this needs 0.0000"), "{message}");
    assert!(message.ends_with("the wallet can spend 0.00001000 ECX."), "{message}");

    let other = other_asset();
    let (code, message) = refusal(&order(vec![coin(1, POLICY, 10_000, 0, 0)], vec![pay(&other, 500, &foreign())]));
    assert_eq!(code, RefusalCode::InsufficientFunds);
    assert!(message.starts_with("Not enough of asset"), "{message}");
}

#[test]
fn an_amount_below_the_dust_threshold_is_refused() {
    // An explicit P2WPKH output: (66 + 67) bytes at 100 sat/kvB, rounded up, is 14.
    let (code, message) = refusal(&order(vec![coin(1, POLICY, 100_000, 0, 0)], vec![pay(POLICY, 13, &foreign())]));
    assert_eq!(code, RefusalCode::Dust);
    assert!(message.contains("(0.00000014 ECX)"), "{message}");
    build(&order(vec![coin(1, POLICY, 100_000, 0, 0)], vec![pay(POLICY, 14, &foreign())]));
}

#[test]
fn change_below_the_dust_threshold_goes_to_the_fee() {
    let payload = build(&order(vec![coin(1, POLICY, 10_000, 0, 0)], vec![pay(POLICY, 10_000 - 30, &foreign())]));
    let view = clear(&payload);
    assert_eq!(rows(&view), [(POLICY.into(), 9_970, foreign(), false)]);
    assert_eq!(view.fee.amount, "30");
}

#[test]
fn a_confidential_address_is_refused_and_its_unconfidential_form_named() {
    let p = &network().params.address_params;
    let params: &'static AddressParams = Box::leak(Box::new(AddressParams {
        p2pkh_prefix: p.p2pkh_prefix,
        p2sh_prefix: p.p2sh_prefix,
        blinded_prefix: p.blinded_prefix,
        bech_hrp: bech32::Hrp::parse(&p.bech_hrp).unwrap(),
        blech_hrp: bech32::Hrp::parse(&p.blech_hrp).unwrap(),
    }));
    let target = key(FOREIGN, 0, 1);
    let blinding = key(FOREIGN, 0, 9).pk.inner;
    let confidential = Address::from_script(&target.script_pubkey, Some(blinding), params).unwrap().to_string();
    assert!(confidential.starts_with("elementsl"));
    let (code, message) = refusal(&order(vec![coin(1, POLICY, 100_000, 0, 0)], vec![pay(POLICY, 5_000, &confidential)]));
    assert_eq!(code, RefusalCode::Confidential);
    assert!(message.ends_with(&format!("Its unconfidential form is {}.", foreign())), "{message}");
}

#[test]
fn an_address_of_another_network_is_refused() {
    let (code, _) = refusal(&order(vec![coin(1, POLICY, 100_000, 0, 0)], vec![pay(POLICY, 5_000, "ert1qw508d6qejxtdg4y5r3zarvary0c5xw7kxw0e3h")]));
    assert_eq!(code, RefusalCode::Malformed);
}

#[test]
fn an_order_without_outputs_or_with_a_coin_listed_twice_is_malformed() {
    assert_eq!(refusal(&order(vec![coin(1, POLICY, 100_000, 0, 0)], vec![])).0, RefusalCode::Malformed);
    let twice = vec![coin(1, POLICY, 100_000, 0, 0), coin(1, POLICY, 100_000, 0, 0)];
    assert_eq!(refusal(&order(twice, vec![pay(POLICY, 5_000, &foreign())])).0, RefusalCode::Malformed);
}

#[test]
fn a_signed_transfer_finalizes_to_the_transaction_with_its_txid() {
    let payload = build(&order(vec![coin(1, POLICY, 100_000, 0, 0), coin(2, POLICY, 1_000, 1, 2)], vec![pay(POLICY, 100_500, &foreign())]));
    let (tx, txid) = signed_tx(&payload);
    assert_eq!(tx.txid().to_string(), txid);
    assert_eq!(tx.input.len(), 2);
    assert!(tx.input.iter().all(|i| i.witness.script_witness.len() == 2));
}

#[test]
fn finalize_refuses_an_unsigned_transfer() {
    let payload = build(&order(vec![coin(1, POLICY, 100_000, 0, 0)], vec![pay(POLICY, 5_000, &foreign())]));
    assert_eq!(finalize(&payload).unwrap_err().message, "Input 0 isn't signed.");
}
