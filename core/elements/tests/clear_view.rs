//! Seam 2: `decode(payload, starter)` returns a Clear View exactly when the Elements Decoder fully
//! understands a request inside its binding (spec stories 32-35, "Chain Module interface").
mod common;

use common::*;
use elements_miniscript::elements::pset::Output;
use elements_miniscript::elements::Script;
use ecx_elements::{decode, network, AssetAmount, ClearIssuance, ClearView, DangerousMode, Decoded, Destination, Evidence};

fn clear(pset: &Pset) -> ClearView {
    match decode(&b64(pset), STARTER, &Evidence::default()).unwrap() {
        Decoded::Clear { view } => view,
        blind => panic!("expected a Clear View, got {blind:?}"),
    }
}

fn blind_reason(pset: &Pset) -> String {
    match decode(&b64(pset), STARTER, &Evidence::default()).unwrap() {
        Decoded::Blind { reason, .. } => reason,
        clear => panic!("expected Blind, got {clear:?}"),
    }
}

#[test]
fn a_plain_explicit_transfer_is_a_clear_view_with_each_output_its_destination_and_the_fee() {
    let view = clear(&transfer());
    let asset = network().params.policy_asset.clone();

    assert!(view.dangerous_modes.is_empty(), "{:?}", view.dangerous_modes);
    assert_eq!(view.outputs.len(), 2, "the fee is its own row: {:?}", view.outputs);
    let (pay, change) = (&view.outputs[0], &view.outputs[1]);
    assert_eq!((pay.index, pay.asset.as_str(), pay.amount.as_str()), (0, asset.as_str(), "120000"));
    assert_eq!(pay.destination, Destination::Address { address: address(FOREIGN, 0, 1), yours: false });
    assert_eq!((change.index, change.amount.as_str()), (1, "29000"));
    assert_eq!(change.destination, Destination::Address { address: address(STARTER, 1, 0), yours: true });
    assert!(address(STARTER, 1, 0).starts_with("elements1"), "the chain's own encoding");
    assert_eq!((view.fee.asset.as_str(), view.fee.amount.as_str()), (asset.as_str(), "1000"));
    // Inputs: ours (signed) and someone else's.
    assert_eq!(view.inputs.iter().map(|i| (i.index, i.amount.as_str(), i.yours)).collect::<Vec<_>>(), vec![(0, "100000", true), (1, "50000", false)]);
}

#[test]
fn an_output_is_yours_only_if_it_re_derives_not_because_it_claims_our_key() {
    let mut pset = transfer();
    // The foreign payment claims our change key's derivation, but its script is someone else's.
    let ours = key(STARTER, 1, 0);
    pset.outputs_mut()[0].bip32_derivation.insert(ours.pk, (ours.fingerprint, ours.path.clone()));
    let view = clear(&pset);
    assert_eq!(view.outputs[0].destination, Destination::Address { address: address(FOREIGN, 0, 1), yours: false });
}

#[test]
fn a_new_issuance_is_a_clear_view_with_the_asset_and_token_the_wallet_derives_itself() {
    use elements_miniscript::elements::{AssetId, ContractHash, OutPoint};
    use elements_miniscript::elements::hashes::Hash;
    let pset = dex_issuance();
    let input = &pset.inputs()[0];
    let entropy = AssetId::generate_asset_entropy(
        OutPoint::new(input.previous_txid, input.previous_output_index),
        ContractHash::from_byte_array([0x5c; 32]),
    );
    let (asset, token) = (AssetId::from_entropy(entropy), AssetId::reissuance_token_from_entropy(entropy, false));

    let view = clear(&pset);
    assert!(view.dangerous_modes.is_empty(), "issuance costs only the fee: {:?}", view.dangerous_modes);
    assert_eq!(
        view.inputs[0].issuance,
        Some(ClearIssuance {
            asset: AssetAmount { asset: asset.to_string(), amount: "1000000".into() },
            token: Some(AssetAmount { asset: token.to_string(), amount: "1".into() }),
            contract_hash: Some(ContractHash::from_byte_array([0x5c; 32]).to_string()),
            contract: None,
        })
    );
    // The new asset and the token go back to the address getAddresses gave out.
    let to = |i: usize| (view.outputs[i].asset.clone(), view.outputs[i].destination.clone());
    let ours = Destination::Address { address: address(STARTER, 0, 0), yours: true };
    assert_eq!(to(0), (asset.to_string(), ours.clone()));
    assert_eq!(to(1), (token.to_string(), ours));
}

#[test]
fn an_issuance_without_a_token_or_a_contract_says_so() {
    let mut pset = dex_issuance();
    pset.inputs_mut()[0].issuance_inflation_keys = None;
    pset.inputs_mut()[0].issuance_asset_entropy = None;
    pset.remove_output(1); // the token
    let issuance = clear(&pset).inputs[0].issuance.clone().unwrap();
    assert_eq!((issuance.token, issuance.contract_hash), (None, None));
}

#[test]
fn a_reissuance_stays_blind_since_an_explicit_token_can_never_reissue() {
    use elements_miniscript::elements::secp256k1_zkp::Tweak;
    let mut pset = dex_issuance();
    pset.inputs_mut()[0].issuance_blinding_nonce = Some(Tweak::from_inner([1; 32]).unwrap());
    let reason = blind_reason(&pset);
    assert!(reason.contains("reissues"), "{reason}");
}

#[test]
fn an_ordinary_input_has_no_issuance() {
    assert!(clear(&transfer()).inputs.iter().all(|i| i.issuance.is_none()));
}

#[test]
fn a_non_default_sighash_is_a_dangerous_mode() {
    use elements_miniscript::elements::pset::PsbtSighashType;
    let mut pset = transfer();
    pset.inputs_mut()[0].sighash_type = Some(PsbtSighashType::from_u32(0x83)); // SINGLE|ANYONECANPAY
    assert_eq!(clear(&pset).dangerous_modes, vec![DangerousMode::NonDefaultSighash { input: 0, sighash: 0x83 }]);
}

#[test]
fn an_explicit_sighash_all_is_not_dangerous() {
    use elements_miniscript::elements::pset::PsbtSighashType;
    let mut pset = transfer();
    pset.inputs_mut()[0].sighash_type = Some(PsbtSighashType::from_u32(0x01));
    assert!(clear(&pset).dangerous_modes.is_empty());
}

#[test]
fn a_sighash_type_the_decoder_does_not_know_is_blind() {
    use elements_miniscript::elements::pset::PsbtSighashType;
    let mut pset = transfer();
    for unknown in [0x1f, 0x41] {
        pset.inputs_mut()[0].sighash_type = Some(PsbtSighashType::from_u32(unknown));
        assert!(blind_reason(&pset).contains("sighash"));
    }
}

#[test]
fn a_withdrawal_burn_is_a_dangerous_mode_and_its_row_names_the_l1_destination_payout_and_parent_fee() {
    let view = clear(&with_withdrawal());
    assert_eq!(view.dangerous_modes, vec![DangerousMode::WithdrawalBurn { output: 3 }]);
    let burn = view.outputs.iter().find(|o| o.index == 3).expect("the burn is a row");
    assert_eq!(burn.amount, "5000");
    assert_eq!(
        burn.destination,
        Destination::Withdrawal {
            l1_address: Some("bc1qzyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3h8ffkz".into()),
            l1_script_pubkey: format!("0014{}", "11".repeat(20)),
            payout: "4000".into(),
            parent_fee: "1000".into(),
        }
    );
}

#[test]
fn a_withdrawal_names_its_l1_destination_as_an_l1_address_and_a_non_standard_script_only_as_hex() {
    // Expected addresses from the reference BIP173/BIP350/base58check encoders, with the parent
    // chain's address parameters (HRP "bc", P2PKH 0, P2SH 5).
    let p2pkh = [&[0x76, 0xa9, 0x14][..], &[0x22; 20], &[0x88, 0xac]].concat();
    let p2sh = [&[0xa9, 0x14][..], &[0x33; 20], &[0x87]].concat();
    let p2tr = [&[0x51, 0x20][..], &[0x44; 32]].concat();
    let non_standard = vec![0x51];
    let cases = [
        (p2pkh, Some("147Us9aEq2PvBC5wobBJw1yEpQEbPKzssA")),
        (p2sh, Some("36MjimMJHwQkrTKrKyw4KepHsd975kSGTs")),
        (p2tr, Some("bc1pg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zq8ss0kf")),
        (non_standard, None),
    ];
    for (l1_script, expected) in cases {
        let mut pset = transfer();
        pset.outputs_mut()[1].amount = Some(24_000);
        pset.add_output(pay(withdrawal_burn_script_to(&l1_script), 5_000));
        let view = clear(&pset);
        let Destination::Withdrawal { l1_address, l1_script_pubkey, .. } = &view.outputs[2].destination else {
            panic!("expected a withdrawal row: {:?}", view.outputs)
        };
        assert_eq!(l1_address.as_deref(), expected);
        assert_eq!(l1_script_pubkey, &l1_script.iter().map(|b| format!("{b:02x}")).collect::<String>());
    }
}

#[test]
fn dangerous_modes_combine() {
    use elements_miniscript::elements::pset::PsbtSighashType;
    let mut pset = with_withdrawal();
    pset.inputs_mut()[0].sighash_type = Some(PsbtSighashType::from_u32(0x82));
    assert_eq!(
        clear(&pset).dangerous_modes,
        vec![DangerousMode::NonDefaultSighash { input: 0, sighash: 0x82 }, DangerousMode::WithdrawalBurn { output: 3 }]
    );
}

#[test]
fn a_withdrawal_burn_the_decoder_can_only_partly_parse_is_blind() {
    use elements_miniscript::elements::script::Builder;
    let burn = withdrawal_burn_script();
    let trailing = Builder::from(burn.to_bytes()).push_slice(&[1, 2, 3]).into_script();
    let cases = [
        ("an extra push", pay(trailing, 5_000)),
        ("a parent fee as large as the burn", pay(burn.clone(), 1_000)),
        ("a burn of another asset", Output::new_explicit(burn, 5_000, other_asset(), None)),
    ];
    for (what, output) in cases {
        let mut pset = transfer();
        pset.add_output(output);
        assert!(blind_reason(&pset).contains("withdrawal"), "{what}");
    }
}

#[test]
fn an_op_return_that_is_not_a_withdrawal_burn_is_blind() {
    use elements_miniscript::elements::opcodes::all::OP_RETURN;
    use elements_miniscript::elements::script::Builder;
    let mut pset = transfer();
    pset.add_output(pay(Builder::new().push_opcode(OP_RETURN).push_slice(b"hello").into_script(), 0));
    blind_reason(&pset);
}

/// Some asset that isn't the policy asset.
fn other_asset() -> elements_miniscript::elements::AssetId {
    elements_miniscript::elements::AssetId::from_slice(&[7; 32]).unwrap()
}

#[test]
fn a_known_field_the_decoder_does_not_explain_makes_the_request_blind_not_a_partial_clear_view() {
    use elements_miniscript::elements::locktime::Height;
    let cases: Vec<(&str, fn(&mut Pset))> = vec![
        ("a peg-in", |p| p.inputs_mut()[1].pegin_value = Some(1)),
        ("a final scriptSig", |p| p.inputs_mut()[1].final_script_sig = Some(Script::from(vec![0x51]))),
        ("a required height locktime", |p| p.inputs_mut()[1].required_height_locktime = Some(Height::from_consensus(5).unwrap())),
        ("a taproot internal key", |p| {
            p.inputs_mut()[1].tap_internal_key = Some(key(FOREIGN, 0, 5).pk.inner.x_only_public_key().0)
        }),
        ("an output witness script", |p| p.outputs_mut()[0].witness_script = Some(Script::from(vec![0x51]))),
        ("a modifiable transaction", |p| p.global.tx_data.tx_modifiable = Some(1)),
    ];
    for (what, mutate) in cases {
        let mut pset = transfer();
        mutate(&mut pset);
        let reason = blind_reason(&pset);
        assert!(reason.contains("doesn't explain"), "{what}: {reason}");
    }
}

#[test]
fn signatures_others_already_added_do_not_stop_a_clear_view() {
    let mut pset = transfer();
    let theirs = key(FOREIGN, 0, 0);
    pset.inputs_mut()[1].partial_sigs.insert(theirs.pk, vec![0x30; 71]);
    clear(&pset);
}

#[test]
fn the_decoder_is_never_applied_outside_its_binding() {
    use ecx_elements::RefusalCode;
    // Another chain's PSET (Liquid mainnet's genesis), otherwise a plain transfer.
    let mut other_chain = transfer();
    set_genesis(&mut other_chain, "1466275836220db2944ca059a3a10ef6fd2ea684b0688d2c379296888a206003");
    assert_eq!(decode(&b64(&other_chain), STARTER, &Evidence::default()).unwrap_err().code, RefusalCode::WrongGenesis);
    // Another format: a Bitcoin PSBT ("psbt\xff" magic).
    assert_eq!(decode("cHNidP8BAAoCAAAAAAAAAAAAAA==", STARTER, &Evidence::default()).unwrap_err().code, RefusalCode::Malformed);
}

#[test]
fn unknown_fields_make_an_otherwise_clear_transfer_blind() {
    assert!(blind_reason(&transfer_with_unknown_fields()).contains("doesn't understand"));
}

#[test]
fn the_fee_shown_is_the_total_of_every_fee_output() {
    let view = clear(&with_two_fee_outputs());
    assert_eq!((view.fee.asset.as_str(), view.fee.amount.as_str()), (network().params.policy_asset.as_str(), "1500"));
    assert_eq!(view.outputs.len(), 2, "fee outputs are not rows: {:?}", view.outputs);
}

#[test]
fn a_fee_output_in_another_asset_than_the_policy_asset_is_blind() {
    let mut pset = transfer();
    pset.add_output(Output::new_explicit(Script::new(), 500, other_asset(), None));
    assert!(blind_reason(&pset).contains("fee"));
}
