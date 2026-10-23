//! Seam 2: a Signing Request's `evidence`, which `decode` checks against the payload before the
//! Clear View shows anything from it (docs/adr/0009). The first kind: `assetContract`, the
//! contract behind a new issuance's committed hash.
mod common;

use common::*;
use ecx_elements::{decode, ClearContract, ClearIssuance, Decoded, Evidence, RefusalCode};

fn evidence(json: &str) -> Evidence {
    Evidence::from_json(json).unwrap()
}

/// `contract` as `assetContract` evidence for input `input`.
fn contract_for(input: &str, contract: &str) -> Evidence {
    evidence(&serde_json::json!({ "assetContract": { input: contract } }).to_string())
}

fn contract_evidence(contract: &str) -> Evidence {
    contract_for("0", contract)
}

fn issuance_shown(pset: &Pset, evidence: &Evidence) -> ClearIssuance {
    match decode(&b64(pset), STARTER, evidence).unwrap() {
        Decoded::Clear { view } => view.inputs[0].issuance.clone().unwrap(),
        blind => panic!("expected a Clear View, got {blind:?}"),
    }
}

fn refusal(pset: &Pset, evidence: &Evidence) -> RefusalCode {
    decode(&b64(pset), STARTER, evidence).expect_err("refused").code
}

#[test]
fn a_contract_matching_the_committed_hash_is_shown_with_its_issuer_key_checked_against_ours() {
    let contract = contract(&key(STARTER, 0, 0), "EXA");
    let shown = issuance_shown(&issuance_of(&contract), &contract_evidence(&contract));
    assert_eq!(
        shown.contract,
        Some(ClearContract {
            name: "Example Asset".into(),
            ticker: "EXA".into(),
            precision: 8,
            domain: "dex.example".into(),
            issuer_yours: true,
        })
    );
}

#[test]
fn an_issuer_key_that_is_not_the_given_out_address_key_is_not_yours() {
    let contract = contract(&key(STARTER, 1, 0), "EXA");
    let shown = issuance_shown(&issuance_of(&contract), &contract_evidence(&contract));
    assert!(!shown.contract.unwrap().issuer_yours);
}

#[test]
fn the_hash_is_the_single_sha_256_of_the_exact_contract_bytes_shown_reversed_as_liquid_does() {
    // Tether USDt's contract and the hash Liquid shows for it (blockstream.info, tx abb4080d…ff3d
    // input 0; the vector LWK's registry tests use).
    let tether = r#"{"entity":{"domain":"tether.to"},"issuer_pubkey":"0337cceec0beea0232ebe14cba0197a9fbd45fcf2ec946749de920e71434c2b904","name":"Tether USD","precision":8,"ticker":"USDt","version":0}"#;
    let shown = issuance_shown(&issuance_of(tether), &contract_evidence(tether));
    assert_eq!(shown.contract_hash.as_deref(), Some("3c7f0a53c2ff5b99590620d7f6604a7a3a7bfbaaa6aa61f7bfc7833ca03cde82"));
    assert_eq!(shown.contract.map(|c| (c.ticker, c.issuer_yours)), Some(("USDt".into(), false)));
}

#[test]
fn a_contract_that_does_not_hash_to_the_committed_hash_is_refused() {
    let committed = contract(&key(STARTER, 0, 0), "EXA");
    let other = contract(&key(STARTER, 0, 0), "EXB");
    assert_eq!(refusal(&issuance_of(&committed), &contract_evidence(&other)), RefusalCode::InvalidEvidence);
    // The same contract, reformatted, is different bytes: the committed bytes are what count.
    let spaced = committed.replace(",", ", ");
    assert_eq!(refusal(&issuance_of(&committed), &contract_evidence(&spaced)), RefusalCode::InvalidEvidence);
}

#[test]
fn a_matching_contract_that_breaks_the_registry_rules_is_refused() {
    let ours = key(STARTER, 0, 0);
    let precision_9 = contract(&ours, "EXA").replace(r#""precision":8"#, r#""precision":9"#);
    let version_1 = contract(&ours, "EXA").replace(r#""version":0"#, r#""version":1"#);
    let no_name = contract(&ours, "EXA").replace(r#""name":"Example Asset","#, "");
    let spoofing_name = contract(&ours, "EXA").replace("Example Asset", r"Example\nApprove this"); // a JSON-escaped newline
    let domain = |d: &str| contract(&ours, "EXA").replace("dex.example", d);
    let pk: String = ours.pk.inner.serialize().iter().map(|b| format!("{b:02x}")).collect();
    let uncompressed: String = ours.pk.inner.serialize_uncompressed().iter().map(|b| format!("{b:02x}")).collect();
    let issuer = |k: &str| contract(&ours, "EXA").replace(&pk, k);
    let bad_domains = [domain("localhost"), domain("Dex.example"), domain("-dex.example"), domain("dex..example")];
    let bad_keys = [issuer(&uncompressed), issuer("02ffff"), issuer(&"00".repeat(33))];
    for bad in [contract(&ours, "X"), contract(&ours, "E X A"), precision_9, version_1, no_name, spoofing_name].into_iter().chain(bad_domains).chain(bad_keys) {
        assert_eq!(refusal(&issuance_of(&bad), &contract_evidence(&bad)), RefusalCode::InvalidEvidence, "{bad}");
    }
}

#[test]
fn a_contract_for_an_input_that_issues_nothing_or_does_not_exist_is_refused() {
    let contract = contract(&key(STARTER, 0, 0), "EXA");
    assert_eq!(refusal(&transfer(), &contract_for("0", &contract)), RefusalCode::InvalidEvidence);
    assert_eq!(refusal(&issuance_of(&contract), &contract_for("7", &contract)), RefusalCode::InvalidEvidence);
    assert_eq!(refusal(&issuance_of(&contract), &contract_for("first", &contract)), RefusalCode::InvalidEvidence);
}

#[test]
fn without_evidence_or_with_only_unknown_kinds_the_issuance_shows_base_units_only() {
    let pset = issuance_of(&contract(&key(STARTER, 0, 0), "EXA"));
    assert_eq!(issuance_shown(&pset, &Evidence::default()).contract, None);
    assert_eq!(issuance_shown(&pset, &evidence(r#"{"someFutureKind":{"x":1}}"#)).contract, None);
}

#[test]
fn evidence_that_is_not_an_object_of_kinds_is_refused() {
    for bad in ["[]", "7", r#"{"assetContract":["{}"]}"#, r#"{"assetContract":{"0":7}}"#, "not json"] {
        assert_eq!(Evidence::from_json(bad).unwrap_err().code, RefusalCode::InvalidEvidence, "{bad}");
    }
}
