//! Tokens and asset names read from whole transactions (`output_tokens`, `asset_registration`).
//!
//! `token-txs.json`: three live Slot 99 transactions, fetched 2026-10-25 from the explorer's
//! `/tx/:txid/hex`: BROSEVELT's registration (kind 35), a SwapPools (kind 21, one result output) and
//! an AddLiquidity (kind 7: BROSEVELT change listed at output 0, then two results).
mod common;

use ecx_flush::{asset_registration, output_tokens, RefusalCode, TokenAmount};
use serde_json::Value;

const BROSEVELT: &str = "7351ccd9fd2f091cce3f9d8e3cd0b95f278885f4610620784b8c64be8b0237c1";
const REGISTRATION: &str = "24fc101fccc71bc60845e190c2ad1e07b332fe7a6de99af37acdaaefdd9db891";
const SWAP: &str = "0944a2452c9b07b99cc6a54dd662cb752738abdb051ec41069638097e9770e9b";
const ADD_LIQUIDITY: &str = "681f2d2c4331fa285b30a59663ae7ed22a548a0f00db16cff72abebafca0ec12";

fn tx(txid: &str) -> String {
    let txs: Value = serde_json::from_str(include_str!("token-txs.json")).unwrap();
    txs[txid].as_str().unwrap().to_owned()
}

#[test]
fn the_txid_is_the_modules_own() {
    for txid in [REGISTRATION, SWAP, ADD_LIQUIDITY] {
        assert_eq!(output_tokens(&tx(txid)).unwrap().txid, txid);
    }
}

#[test]
fn a_listed_output_carries_the_token_its_marker_names_and_a_result_carries_none_the_wallet_can_read() {
    let add = output_tokens(&tx(ADD_LIQUIDITY)).unwrap();
    let outputs: Vec<_> = add.outputs.iter().map(|o| (o.vout, o.token.clone())).collect();
    let change = outputs[0].1.clone().unwrap();
    assert_eq!((outputs[0].0, change.kind.as_str(), change.id.as_str()), (0, "asset", BROSEVELT));
    assert_eq!(outputs[1..], [(1, None), (2, None)]);

    let swap = output_tokens(&tx(SWAP)).unwrap();
    assert_eq!(swap.outputs.iter().map(|o| (o.vout, o.token.is_none())).collect::<Vec<_>>(), [(0, true)]);
}

#[test]
fn a_registration_names_its_asset_by_its_ticker_and_display_name() {
    let reg = asset_registration(BROSEVELT, &tx(REGISTRATION)).unwrap();
    assert_eq!(reg.txid, REGISTRATION);
    assert_eq!((reg.ticker.as_str(), reg.name.as_str(), reg.decimals), ("BROSEVELT", "Theodore Brosevelt", 2));
}

#[test]
fn a_transaction_that_isnt_the_assets_registration_names_nothing() {
    let other = "617a6ad47771d6161d35023a90e7b5134ee6317c4f3d38475ec2cde540acb04f";
    let refusal = asset_registration(other, &tx(REGISTRATION)).unwrap_err();
    assert_eq!(refusal.code, RefusalCode::InvalidContract);
    assert!(refusal.message.contains(&format!("registers asset {BROSEVELT}, not {other}")), "{}", refusal.message);

    let refusal = asset_registration(BROSEVELT, &tx(SWAP)).unwrap_err();
    assert_eq!(refusal.code, RefusalCode::InvalidContract);
    assert!(refusal.message.contains("doesn't register an asset: it is a swap_pools"), "{}", refusal.message);
}

#[test]
fn a_transaction_without_a_marker_lists_no_tokens() {
    let plain = common::tx_hex(&common::paying(1, &[(&common::script(common::STARTER, 0, 0), 50_000)]));
    assert_eq!(output_tokens(&plain).unwrap().outputs, []);
    assert_eq!(asset_registration(BROSEVELT, &plain).unwrap_err().code, RefusalCode::InvalidContract);
}

#[test]
fn what_isnt_a_transaction_is_refused() {
    assert_eq!(output_tokens("00").unwrap_err().code, RefusalCode::Malformed);
}

#[test]
fn token_amounts_are_decimal_strings() {
    let add = output_tokens(&tx(ADD_LIQUIDITY)).unwrap();
    let TokenAmount { amount, .. } = add.outputs[0].token.clone().unwrap();
    assert!(amount.parse::<u64>().is_ok(), "{amount}");
}
