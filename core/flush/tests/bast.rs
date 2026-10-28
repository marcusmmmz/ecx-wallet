//! The `BAST` marker decoder against live betanet transactions and hand-built markers.
//!
//! `bast-vectors.json`: 12 live Slot 99 transactions (kinds 1, 2, 7, 18, 20, 21, 23, 24, 25, 26, 27,
//! 35), recorded 2026-10-25 with the reference decoder of #58, whose listed outputs match the
//! explorer's `/flush/tx`. The hand-built vectors are #59's (a kind-0 transfer, a control coin).
use ecx_flush::bast::{asset_id, is_marker, parse, pool_id, swap_pools_marker, transfer_marker, PoolKind, TokenKind};
use serde_json::Value;

const VECTORS: &str = include_str!("bast-vectors.json");

fn unhex(s: &str) -> Vec<u8> {
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
}

fn vectors() -> Vec<Value> {
    serde_json::from_str(VECTORS).unwrap()
}

#[test]
fn every_live_marker_decodes_as_the_reference_decoder_does() {
    for v in vectors() {
        let marker = parse(&unhex(v["marker_hex"].as_str().unwrap())).unwrap_or_else(|e| panic!("{}: {e}", v["txid"]));
        assert_eq!(marker.to_json(), v["decoded"], "{}", v["txid"]);
    }
}

#[test]
fn every_live_markers_listed_outputs_are_what_the_explorer_reports() {
    for v in vectors() {
        let marker = parse(&unhex(v["marker_hex"].as_str().unwrap())).unwrap();
        assert_eq!(marker.to_json()["outputs"], v["flush_tx_asset"]["outputs"], "{}", v["txid"]);
    }
}

#[test]
fn a_registration_names_its_ticker_decimals_and_display_name_and_its_id_is_the_tickers_hash() {
    let brosevelt = vectors().into_iter().find(|v| v["decoded"]["kind"] == 35).unwrap();
    let reg = parse(&unhex(brosevelt["marker_hex"].as_str().unwrap())).unwrap().registration().unwrap();
    assert_eq!(reg.asset, "7351ccd9fd2f091cce3f9d8e3cd0b95f278885f4610620784b8c64be8b0237c1");
    assert_eq!(reg.ticker.as_deref(), Some("BROSEVELT"));
    assert_eq!(reg.display_name.as_deref(), Some("Theodore Brosevelt"));
    assert_eq!((reg.supply, reg.decimals), (100_000_000, 2));
    assert_eq!(asset_id("BROSEVELT"), reg.asset);
}

#[test]
fn asset_ids_are_the_tickers_sha256_byte_reversed() {
    // Verified live on every asset of the Slot 99 chain (#58).
    assert_eq!(asset_id("FLUSH"), "617a6ad47771d6161d35023a90e7b5134ee6317c4f3d38475ec2cde540acb04f");
}

#[test]
fn a_transfer_lists_each_token_output_with_its_amount() {
    let script = "6a4c52424153540000020000c137028bbe648c4b78200661f48588275fb9d03c8e9d3fce1c092ffdd9cc5173858c200100c137028bbe648c4b78200661f48588275fb9d03c8e9d3fce1c092ffdd9cc517381a9f663";
    let marker = parse(&unhex(script)).unwrap();
    assert_eq!((marker.kind, marker.name), (0, "transfer"));
    let outputs: Vec<_> = marker.outputs.iter().map(|o| (o.n, o.token.as_ref().unwrap().amount)).collect();
    assert_eq!(outputs, [(0, 100_000), (1, 4_897_763)]);
    let token = marker.outputs[0].token.as_ref().unwrap();
    assert_eq!((token.kind, token.id.as_str()), (TokenKind::Asset, "7351ccd9fd2f091cce3f9d8e3cd0b95f278885f4610620784b8c64be8b0237c1"));
    assert_eq!(marker.registration(), None);
}

#[test]
fn a_control_coin_is_listed_without_an_amount_and_carries_one() {
    let marker = parse(&unhex("6a29424153540000010001c137028bbe648c4b78200661f48588275fb9d03c8e9d3fce1c092ffdd9cc5173")).unwrap();
    let token = marker.outputs[0].token.as_ref().unwrap();
    assert_eq!((marker.outputs[0].n, token.kind, token.amount), (0, TokenKind::Control, 1));
}

#[test]
fn a_result_output_carries_no_token_the_marker_can_name() {
    let swap = vectors().into_iter().find(|v| v["decoded"]["kind"] == 21).unwrap();
    let marker = parse(&unhex(swap["marker_hex"].as_str().unwrap())).unwrap();
    assert_eq!((marker.outputs[0].n, &marker.outputs[0].token), (0, &None));
}

/// A kind-37 launch (backbone-flush `flush-betanet`): no live one exists, so it is built here
/// field by field. `fee_flow` is (destination, burn_bps, keep_control).
/// A LaunchToken marker of `kind` registering TEST, its network's fee, then `tail`: the kind's own fields.
fn launch(kind: u8, tail: &[u8]) -> Vec<u8> {
    let mut b = b"BAST\x00".to_vec();
    b.push(kind);
    let mut id = unhex(&asset_id("TEST"));
    id.reverse();
    b.extend(&id); // asset, internal order
    b.extend([0u8; 32]); // nonce
    b.push(100); // supply (VARINT)
    b.push(6); // decimals
    b.extend([0; 6]); // AssetData: six absent fields
    b.extend([1, 4]);
    b.extend(b"TEST"); // ticker
    b.push(0); // no logo
    b.push(4);
    b.extend(b"Test"); // display name
    b.extend([0x16, 0x00, 0x14]);
    b.extend([0x11; 20]); // creator script
    b.extend([0x00, 0x00]); // allocation
    b.extend([0x00, 0x00, 0x00, 0x00]); // min_buy, max_buy, first_buy, first_min_out
    b.push(0); // chn_to: empty
    b.push(0); // fee: the network's
    b.extend(tail);
    b.push(0); // no listed outputs
    let mut script = vec![0x6a, 0x4c, b.len() as u8];
    script.extend(b);
    script
}

fn launch_v5(fee_flow: (u8, u16, u8)) -> Vec<u8> {
    let mut tail = vec![fee_flow.0];
    tail.extend(fee_flow.1.to_le_bytes());
    tail.push(fee_flow.2);
    launch(37, &tail)
}

/// A launch with a fee split (kind 38): keep_control, then the split's shares as (kind, script, bps).
fn launch_v7(keep_control: u8, split: &[(u8, &[u8], u16)]) -> Vec<u8> {
    let mut tail = vec![keep_control, split.len() as u8];
    for (kind, script, bps) in split {
        tail.extend([*kind, script.len() as u8]);
        tail.extend(*script);
        tail.extend(bps.to_le_bytes());
    }
    launch(38, &tail)
}

#[test]
fn a_fee_flow_launch_registers_its_token() {
    let marker = parse(&launch_v5((2, 2500, 1))).unwrap();
    assert_eq!((marker.kind, marker.name), (37, "launch_fee_flow"));
    assert_eq!((&marker.fields["destination"], &marker.fields["burn_bps"], &marker.fields["keep_control"]), (&2.into(), &2500.into(), &true.into()));
    let reg = marker.registration().unwrap();
    assert_eq!((reg.asset, reg.ticker.as_deref(), reg.display_name.as_deref(), reg.decimals), (asset_id("TEST"), Some("TEST"), Some("Test"), 6));
}

#[test]
fn a_fee_flow_launch_with_only_the_defaults_is_refused_since_it_is_written_as_an_older_kind() {
    assert!(parse(&launch_v5((0, 0, 0))).unwrap_err().contains("kind 22 or 36"));
    assert!(parse(&launch_v5((3, 0, 0))).unwrap_err().contains("fee destination"));
}

#[test]
fn a_fee_split_launch_registers_its_token() {
    let address = [0x00, 0x14, 0x22, 0x22, 0x22, 0x22, 0x22, 0x22, 0x22, 0x22, 0x22, 0x22, 0x22, 0x22, 0x22, 0x22, 0x22, 0x22, 0x22, 0x22, 0x22, 0x22];
    let marker = parse(&launch_v7(1, &[(0, &[], 6000), (1, &[], 1000), (2, &address, 3000)])).unwrap();
    assert_eq!((marker.kind, marker.name), (38, "launch_fee_split"));
    assert_eq!(marker.fields["keep_control"], true);
    let split = marker.fields["split"].as_array().unwrap();
    assert_eq!(split.len(), 3);
    assert_eq!((&split[2]["kind"], &split[2]["script"], &split[2]["bps"]), (&2.into(), &format!("0014{}", "22".repeat(20)).into(), &3000.into()));
    let reg = marker.registration().unwrap();
    assert_eq!((reg.asset, reg.ticker.as_deref(), reg.display_name.as_deref(), reg.decimals), (asset_id("TEST"), Some("TEST"), Some("Test"), 6));
}

#[test]
fn a_fee_split_launch_without_a_split_is_refused_since_it_is_written_as_an_older_kind() {
    assert!(parse(&launch_v7(0, &[])).unwrap_err().contains("kind 22, 36 or 37"));
}

#[test]
fn a_marker_the_node_would_not_read_is_refused() {
    let transfer = unhex("6a29424153540000010001c137028bbe648c4b78200661f48588275fb9d03c8e9d3fce1c092ffdd9cc5173");
    let refused = |script: &[u8]| parse(script).unwrap_err();

    assert_eq!(refused(&transfer[..transfer.len() - 1]), "push length runs past the script");
    let mut trailing = transfer.clone();
    trailing[1] += 1;
    trailing.push(0);
    assert_eq!(refused(&trailing), "trailing bytes");
    let mut version = transfer.clone();
    version[6] = 1;
    assert_eq!(refused(&version), "version is not 0");
    let mut pushdata1 = vec![0x6a, 0x4c];
    pushdata1.extend(&transfer[1..]);
    assert_eq!(refused(&pushdata1), "the push isn't minimal");
    let mut kind = transfer.clone();
    kind[7] = 29;
    assert_eq!(refused(&kind), "unknown operation kind 29");
    let mut bool_byte = transfer.clone();
    bool_byte[10] = 7;
    assert_eq!(refused(&bool_byte), "unknown token kind");
}

#[test]
fn a_script_claiming_the_tag_is_a_marker_even_if_it_does_not_parse() {
    // The node counts it as a marker (IsMarkerScript), so the transaction is invalid, not a payment.
    let mut pushdata1 = vec![0x6a, 0x4c, 0x05];
    pushdata1.extend(b"BAST\x07");
    assert!(is_marker(&pushdata1));
    assert!(parse(&pushdata1).is_err());
    assert!(!is_marker(&unhex("6a0474657374")));
}

#[test]
fn varints_have_one_encoding_each() {
    // Burn (kind 5) of one asset token: its amount is the VARINT under test. The values are Core's
    // own (serialize.h): 0=00, 127=7f, 128=8000, 255=807f, 16384=ff00, 2^32=8efefeff00.
    let burn = |amount: &str| {
        let mut b = b"BAST\x00\x05\x01\x00".to_vec();
        b.extend([0xab; 32]);
        b.extend(unhex(amount));
        b.push(0);
        let mut script = vec![0x6a, b.len() as u8];
        script.extend(b);
        parse(&script).map(|m| m.fields["tokens"][0]["amount"].as_u64().unwrap())
    };
    for (hex, value) in [("00", 0), ("7f", 127), ("8000", 128), ("807f", 255), ("ff00", 16384), ("8efefeff00", 1 << 32)] {
        assert_eq!(burn(hex), Ok(value), "{hex}");
    }
    assert_eq!(burn("80808080808080808080ff00"), Err("VARINT too large".into()));
}

#[test]
fn a_transfer_marker_is_written_as_the_node_writes_it() {
    let brosevelt = "7351ccd9fd2f091cce3f9d8e3cd0b95f278885f4610620784b8c64be8b0237c1";
    let script = transfer_marker(&[(0, brosevelt, 100_000), (1, brosevelt, 4_897_763)]).unwrap();
    assert_eq!(
        script,
        unhex("6a4c52424153540000020000c137028bbe648c4b78200661f48588275fb9d03c8e9d3fce1c092ffdd9cc5173858c200100c137028bbe648c4b78200661f48588275fb9d03c8e9d3fce1c092ffdd9cc517381a9f663")
    );
    let one = transfer_marker(&[(3, brosevelt, 1)]).unwrap();
    assert_eq!(one[1] as usize, one.len() - 2, "a short marker is a direct push");
    assert_eq!(parse(&one).unwrap().outputs[0].n, 3);
    assert!(transfer_marker(&[(1, brosevelt, 1), (0, brosevelt, 1)]).is_err());
}

#[test]
fn a_trades_marker_is_written_as_the_node_writes_it() {
    // Two live launch buys (kind 21 through one pool, ECX in): their result output, then the marker.
    let ecx = "00".repeat(32);
    let fork_pool = "2b16f8c06c0f98034bacfe23cec9e36ce96b3d1282766dd957901435354b402a";
    let chn_to = unhex("0014d2b71e70a5dbfa36767c62f0b169ca766b4189bf");
    let script = swap_pools_marker(&ecx, &[fork_pool], 50_000, 220_187, &chn_to, &[(0, None)]).unwrap();
    assert_eq!(
        script,
        unhex("6a4c674241535400150000000000000000000000000000000000000000000000000000000000000000012a404b3535149057d96d7682123d6be96ce3c9ce23feac4b03980f6cc0f8162b8285508cb71b160014d2b71e70a5dbfa36767c62f0b169ca766b4189bf0100ff"),
        "0f18f338…4e33"
    );
    let live = vectors().into_iter().find(|v| v["decoded"]["kind"] == 21).unwrap();
    let f = &live["decoded"]["fields"];
    let pools = [f["pools"][0].as_str().unwrap()];
    let script = swap_pools_marker(&ecx, &pools, f["amount_in"].as_u64().unwrap(), f["min_out"].as_u64().unwrap(), &unhex(f["chn_to"].as_str().unwrap()), &[(0, None)]).unwrap();
    assert_eq!(script, unhex(live["marker_hex"].as_str().unwrap()), "{}", live["txid"]);
    // Token change of what goes in is listed first, with its amount; no ECX either side: no chn_to.
    let fork = "6bb2ae6e23e626cd2fba1f8845d8bbc047aeb9a8f4690ee9a21b5d04584dfb03";
    let sale = parse(&swap_pools_marker(fork, &[fork_pool], 7, 1, &[], &[(0, Some((fork, 3))), (1, None)]).unwrap()).unwrap();
    assert_eq!(sale.to_json()["fields"]["chn_to"], "");
    assert_eq!(sale.to_json()["outputs"], serde_json::json!([{ "n": 0, "carries": "asset", "id": fork, "amount": 3 }, { "n": 1, "carries": "result" }]));
    assert!(swap_pools_marker(&ecx, &[fork_pool], 1, 1, &[], &[(1, None), (0, None)]).is_err());
}

#[test]
fn a_pools_id_is_its_assets_and_kind_hashed() {
    // Live betanet pools, each read with getpool: a launch curve, a legacy pool, a concentrated one with a dynamic fee.
    let ecx = "00".repeat(32);
    let flush = "617a6ad47771d6161d35023a90e7b5134ee6317c4f3d38475ec2cde540acb04f";
    let brosevelt = "7351ccd9fd2f091cce3f9d8e3cd0b95f278885f4610620784b8c64be8b0237c1";
    let kind = |curve, fee, flags| PoolKind { curve, fee, amp: 0, weight0: 0, flags };
    assert_eq!(pool_id(flush, &ecx, &kind(3, 5000, 0)).unwrap(), "6e1ead05c56c42bf7be20de55a3ab44e824c32d5e229960b5d700fcd99c728fa");
    assert_eq!(pool_id(&ecx, brosevelt, &kind(0, 3000, 0)).unwrap(), "de3e837a20bb43ff7d876ac8f981debcd0ef7eae5ee212546c753264095044c2");
    assert_eq!(pool_id(brosevelt, &ecx, &kind(4, 500, 1)).unwrap(), "2a1dbe3c10bc5781a59dd40e2f516dab62b1d15170c8788a7a5c87a4076cc7a9");
    // Another kind or fee is another pool.
    assert_ne!(pool_id(flush, &ecx, &kind(3, 3000, 0)).unwrap(), "6e1ead05c56c42bf7be20de55a3ab44e824c32d5e229960b5d700fcd99c728fa");
}
