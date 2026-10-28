//! Tokens and asset names read from whole transactions (`output_tokens`, `asset_registration`).
//!
//! `token-txs.json`: live Slot 99 transactions from the explorer's `/tx/:txid/hex`: BROSEVELT's
//! registration (kind 35), a SwapPools (kind 21, one result output) and an AddLiquidity (kind 7:
//! BROSEVELT change listed at output 0, then two results), fetched 2026-10-25; BROSEVELT's SetLogo
//! (kind 32, a 15,798-byte JPEG), fetched 2026-10-27.
mod common;

use bitcoin::hashes::{sha256, Hash};
use ecx_flush::{asset_logo, asset_registration, output_tokens, RefusalCode, SwapOrder, TokenAmount};
use serde_json::Value;

const BROSEVELT: &str = "7351ccd9fd2f091cce3f9d8e3cd0b95f278885f4610620784b8c64be8b0237c1";
const REGISTRATION: &str = "24fc101fccc71bc60845e190c2ad1e07b332fe7a6de99af37acdaaefdd9db891";
const SWAP: &str = "0944a2452c9b07b99cc6a54dd662cb752738abdb051ec41069638097e9770e9b";
const ADD_LIQUIDITY: &str = "681f2d2c4331fa285b30a59663ae7ed22a548a0f00db16cff72abebafca0ec12";
const SET_LOGO: &str = "7958bc9b161e2bacc98e66bd7c6a01457809817a4c0cfcecc749504ad38e8d44";

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
fn a_listed_output_names_the_script_it_pays() {
    let raw = tx(ADD_LIQUIDITY);
    let parsed: bitcoin::Transaction = bitcoin::consensus::encode::deserialize_hex(&raw).unwrap();
    let add = output_tokens(&raw).unwrap();
    for listed in &add.outputs {
        let script = &parsed.output[listed.vout as usize].script_pubkey;
        assert_eq!(listed.script, script.as_bytes().iter().map(|b| format!("{b:02x}")).collect::<String>());
    }
}

#[test]
fn a_listed_output_to_a_script_the_node_cant_spend_is_refused() {
    // Flush Core's `Spendable`: P2PKH, P2SH, P2WPKH, P2WSH or P2TR, else `bad-ba-token-output`.
    let mut parsed: bitcoin::Transaction = bitcoin::consensus::encode::deserialize_hex(&tx(ADD_LIQUIDITY)).unwrap();
    parsed.output[0].script_pubkey = bitcoin::ScriptBuf::from_bytes(vec![0x51]);
    let refusal = output_tokens(&bitcoin::consensus::encode::serialize_hex(&parsed)).unwrap_err();
    assert_eq!(refusal.code, RefusalCode::Malformed);
    assert!(refusal.message.contains("lists output 0, whose script"), "{}", refusal.message);
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

#[test]
fn a_logo_is_the_image_its_set_logo_carries() {
    let logo = asset_logo(BROSEVELT, &tx(SET_LOGO)).unwrap();
    assert_eq!((logo.asset.as_str(), logo.txid.as_str(), logo.mime.as_str()), (BROSEVELT, SET_LOGO, "image/jpeg"));
    let bytes: Vec<u8> = (0..logo.bytes.len()).step_by(2).map(|i| u8::from_str_radix(&logo.bytes[i..i + 2], 16).unwrap()).collect();
    assert_eq!(bytes.len(), 15_798);
    // The hash Flush's node reports for it (`getasset`'s `logo.hash`).
    assert_eq!(sha256::Hash::hash(&bytes).to_string(), "68472f4e69ed0aa96feac3e61f5a35bc119d34d33bce57af4a9d641a4ee730ed");
}

#[test]
fn a_logo_is_refused_from_a_transaction_that_sets_none_or_sets_another_assets() {
    let refused = |asset: &str, txid: &str| asset_logo(asset, &tx(txid)).unwrap_err();
    // The registration carries no logo; the swap is no logo operation.
    assert_eq!(refused(BROSEVELT, REGISTRATION).code, RefusalCode::InvalidContract);
    assert!(refused(BROSEVELT, SWAP).message.contains("sets no logo"));
    assert!(refused(&"ab".repeat(32), SET_LOGO).message.contains("not abab"));
}

#[test]
fn a_trade_through_pools_carries_its_order_and_nothing_else_does() {
    // The live sale of 1,234 BROSEVELT (trade-fixtures.json), as the explorer's `/flush/tx` decodes it.
    let fixtures: Value = serde_json::from_str(include_str!("trade-fixtures.json")).unwrap();
    let sale = output_tokens(fixtures["sale"]["hex"].as_str().unwrap()).unwrap();
    assert_eq!(
        sale.swap,
        Some(SwapOrder {
            asset_in: BROSEVELT.into(),
            pools: vec!["2a1dbe3c10bc5781a59dd40e2f516dab62b1d15170c8788a7a5c87a4076cc7a9".into()],
            amount_in: "123400".into(),
            min_out: "1198073".into(),
            chn_to: "001441005036893efdc78c77c4a8f6b621a6e6a2753b".into(),
        })
    );
    let json = serde_json::to_value(&sale).unwrap();
    assert_eq!(json["swap"]["amountIn"], "123400", "camelCase, amounts as decimal strings");

    for txid in [REGISTRATION, ADD_LIQUIDITY, SET_LOGO] {
        let listed = output_tokens(&tx(txid)).unwrap();
        assert_eq!(listed.swap, None, "{txid}");
        assert!(serde_json::to_value(&listed).unwrap().get("swap").is_none(), "absent, not null");
    }
}
