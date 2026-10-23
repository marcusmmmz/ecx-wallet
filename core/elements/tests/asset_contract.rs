//! Seam 2: `asset_contract`, an asset's contract checked against the outpoint its issuance spent
//! (docs/adr/0010): the asset id is derived from the two, never taken from a server.
mod common;

use common::*;
use ecx_elements::{asset_contract, CheckedContract, RefusalCode};

// Tether USDt on Liquid, as blockstream.info's `/asset/ce091c99…7bd2` reports it: issued by tx
// abb4080d…ff3d input 0, which spent 9596d259…8668:0.
const USDT: &str = "ce091c998b83c78bb71a632313ba3760f1763d9cfcffae02258ffa9865a37bd2";
const USDT_PREVOUT: &str = "9596d259270ef5bac0020435e6d859aea633409483ba64e232b8ba04ce288668";
const USDT_CONTRACT: &str = r#"{"entity":{"domain":"tether.to"},"issuer_pubkey":"0337cceec0beea0232ebe14cba0197a9fbd45fcf2ec946749de920e71434c2b904","name":"Tether USD","precision":8,"ticker":"USDt","version":0}"#;

fn refusal(asset: &str, txid: &str, vout: u32, contract: &str) -> RefusalCode {
    asset_contract(asset, txid, vout, contract).expect_err("refused").code
}

#[test]
fn the_contract_an_asset_was_issued_with_is_checked_by_deriving_its_id() {
    assert_eq!(
        asset_contract(USDT, USDT_PREVOUT, 0, USDT_CONTRACT).unwrap(),
        CheckedContract { asset: USDT.into(), name: "Tether USD".into(), ticker: "USDt".into(), precision: 8, domain: "tether.to".into() }
    );
}

#[test]
fn a_new_issuance_the_wallet_signed_checks_out_against_its_input() {
    let contract = contract(&key(STARTER, 0, 0), "EXA");
    let pset = issuance_of(&contract);
    let input = &pset.inputs()[0];
    let asset = input.issuance_ids().0.to_string();
    let checked = asset_contract(&asset, &input.previous_txid.to_string(), input.previous_output_index, &contract).unwrap();
    assert_eq!((checked.asset, checked.ticker, checked.precision), (asset, "EXA".into(), 8));
}

#[test]
fn another_contract_another_outpoint_or_another_asset_is_refused() {
    let reformatted = USDT_CONTRACT.replace(',', ", ");
    let renamed = USDT_CONTRACT.replace("Tether USD", "Tether USD2");
    for contract in [reformatted.as_str(), renamed.as_str()] {
        assert_eq!(refusal(USDT, USDT_PREVOUT, 0, contract), RefusalCode::InvalidContract, "{contract}");
    }
    assert_eq!(refusal(USDT, USDT_PREVOUT, 1, USDT_CONTRACT), RefusalCode::InvalidContract);
    assert_eq!(refusal(USDT, &"11".repeat(32), 0, USDT_CONTRACT), RefusalCode::InvalidContract);
    assert_eq!(refusal(&"22".repeat(32), USDT_PREVOUT, 0, USDT_CONTRACT), RefusalCode::InvalidContract);
}

#[test]
fn a_contract_that_breaks_the_registry_rules_is_refused_even_if_it_is_the_assets() {
    // A real issuance can commit to any bytes: the id matching doesn't make them a contract.
    let bad = contract(&key(STARTER, 0, 0), "X");
    let pset = issuance_of(&bad);
    let input = &pset.inputs()[0];
    let asset = input.issuance_ids().0.to_string();
    let refused = asset_contract(&asset, &input.previous_txid.to_string(), input.previous_output_index, &bad).expect_err("refused");
    assert_eq!(refused.code, RefusalCode::InvalidContract);
    assert!(refused.message.contains("ticker"), "{}", refused.message);
}

#[test]
fn ids_that_are_not_hex_are_refused() {
    assert_eq!(refusal("not hex", USDT_PREVOUT, 0, USDT_CONTRACT), RefusalCode::InvalidContract);
    assert_eq!(refusal(USDT, "not hex", 0, USDT_CONTRACT), RefusalCode::InvalidContract);
}
