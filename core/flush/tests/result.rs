//! A trade's result output, spent (docs/adr/0013): its marker lists no token for it, so the market
//! index's word for what it carries counts only once it fits the order its own transaction states.
//! The trades here are the module's own, built from FORK's live launch pool (trade-fixtures.json).
mod common;

use std::str::FromStr;

use bitcoin::psbt::Psbt;
use bitcoin::ScriptBuf;
use common::{address, paying, script, tx_hex, FOREIGN, STARTER};
use ecx_flush::bast::transfer_marker;
use ecx_flush::{build_trade, build_transfer, decode, decode_with_evidence, finalize, sign, ClearView, Decoded, RefusalCode};
use serde_json::{json, Value};

const FIXTURES: &str = include_str!("trade-fixtures.json");
const NOW: i64 = 1_800_000_000;
const FORK: &str = "6bb2ae6e23e626cd2fba1f8845d8bbc047aeb9a8f4690ee9a21b5d04584dfb03";
const BROSEVELT: &str = "7351ccd9fd2f091cce3f9d8e3cd0b95f278885f4610620784b8c64be8b0237c1";
const FEE_RATE: u64 = 1000;

fn fork_pool() -> Value {
    serde_json::from_str::<Value>(FIXTURES).unwrap()["forkPool"].clone()
}

fn trade(verb: &str, params: &str, quote: f64, coins: Vec<Value>) -> String {
    let f: Value = serde_json::from_str(FIXTURES).unwrap();
    let order = json!({
        "link": format!("flush:{verb}?v=1&network=ecashbeta&exp={}&{params}", NOW + 600), "now": NOW, "pools": [f["forkPool"]],
        "registrations": [f["forkRegistration"]["hex"]], "quote": quote, "minPayout": 0.00005, "coins": coins, "feeRate": FEE_RATE, "changeIndex": 2,
    });
    let built = build_trade(&order.to_string(), STARTER).unwrap();
    tx_hex(&Psbt::from_str(&built.pset).unwrap().unsigned_tx)
}

fn ecx_coin(seed: u8, sats: u64) -> Value {
    json!({ "tx": tx_hex(&paying(seed, &[(&script(STARTER, 0, 1), sats)])), "vout": 0, "chain": 0, "index": 1 })
}

/// A buy of FORK for 10,000 sat, at least 44,000 FORK: its result is output 0, at 0/0.
fn buy() -> String {
    trade("buy", &format!("launch=FORK&asset={FORK}&ecx=0.0001&min_tokens=0.044"), 0.044482, vec![ecx_coin(1, 100_000)])
}

/// A sale of 50,000 FORK, at least 10,000 sat: its result is output 1, at 0/0.
fn sale() -> String {
    let marker = ScriptBuf::from_bytes(transfer_marker(&[(0, FORK, 80_000)]).unwrap());
    let fork = json!({ "tx": tx_hex(&paying(2, &[(&script(STARTER, 0, 0), 0), (&marker, 0)])), "vout": 0, "chain": 0, "index": 0 });
    trade("sell", &format!("launch=FORK&asset={FORK}&tokens=0.05&min_ecx=0.0001"), 0.00011, vec![fork, ecx_coin(3, 20_000)])
}

fn result_coin(tx: &str, vout: u32, asset: &str, amount: u64) -> Value {
    json!({ "tx": tx, "vout": vout, "chain": 0, "index": 0, "result": { "asset": asset, "amount": amount.to_string(), "pools": [fork_pool()] } })
}

fn send(asset: &str, units: u64, coins: Vec<Value>) -> String {
    let to = address(FOREIGN, 0, 0);
    json!({ "coins": coins, "outputs": [{ "asset": asset, "amount": units.to_string(), "to": { "address": to } }], "feeRate": FEE_RATE, "changeIndex": 2 }).to_string()
}

fn txid(tx: &str) -> String {
    bitcoin::consensus::encode::deserialize_hex::<bitcoin::Transaction>(tx).unwrap().compute_txid().to_string()
}

fn evidence(tx: &str, vout: u32, asset: &str, amount: u64) -> Value {
    json!({ "results": [{ "txid": txid(tx), "vout": vout, "asset": asset, "amount": amount.to_string(), "pools": [fork_pool()] }] })
}

fn decoded(psbt: &Psbt, evidence: &Value) -> Decoded {
    decode_with_evidence(&psbt.to_string(), STARTER, &evidence.to_string()).unwrap()
}

fn clear(decoded: Decoded) -> ClearView {
    match decoded {
        Decoded::Clear { view } => view,
        blind => panic!("expected a Clear View, got {blind:?}"),
    }
}

#[test]
fn a_filled_buys_result_is_spent_as_the_pools_other_asset_and_decodes_clear_with_its_evidence() {
    let buy = buy();
    let order = send(FORK, 30_000, vec![ecx_coin(4, 100_000), result_coin(&buy, 0, FORK, 44_482)]);
    let psbt = Psbt::from_str(&build_transfer(&order, STARTER).unwrap().pset).unwrap();
    let tx = &psbt.unsigned_tx;
    let marker = ecx_flush::bast::parse(tx.output[2].script_pubkey.as_bytes()).unwrap();
    let listed: Vec<_> = marker.outputs.iter().map(|o| (o.n, o.token.as_ref().unwrap().amount)).collect();
    assert_eq!((marker.kind, listed), (0, vec![(0, 30_000), (1, 14_482)]), "the payment, then its change: every unit the result carries");

    // Without the index's word, the Decoder can't tell what the result carries: Blind.
    assert!(matches!(decode(&psbt.to_string(), STARTER).unwrap(), Decoded::Blind { .. }));
    let view = clear(decoded(&psbt, &evidence(&buy, 0, FORK, 44_482)));
    let result_input = view.inputs.iter().find(|i| i.asset == FORK).expect("the result, as FORK");
    assert_eq!(result_input.amount, "44482");

    let signed = sign(&psbt.to_string(), STARTER).unwrap();
    assert!(finalize(&signed).is_ok());
}

#[test]
fn a_missed_sales_result_is_its_refund_exactly() {
    let sale = sale();
    let refund = send(FORK, 50_000, vec![ecx_coin(4, 100_000), result_coin(&sale, 1, FORK, 50_000)]);
    let psbt = Psbt::from_str(&build_transfer(&refund, STARTER).unwrap().pset).unwrap();
    clear(decoded(&psbt, &evidence(&sale, 1, FORK, 50_000)));
    // Any other amount of what went in is neither its refund nor a fill.
    let off = build_transfer(&send(FORK, 100, vec![ecx_coin(4, 100_000), result_coin(&sale, 1, FORK, 49_999)]), STARTER).unwrap_err();
    assert!(off.message.contains("neither its fill"), "{}", off.message);
}

#[test]
fn a_claim_that_doesnt_fit_the_order_is_refused_by_the_builder_and_the_decoder() {
    let buy = buy();
    let refused = |coin: Value| build_transfer(&send(FORK, 100, vec![ecx_coin(4, 100_000), coin]), STARTER).unwrap_err();
    for (coin, why) in [
        (result_coin(&buy, 0, BROSEVELT, 44_482), "neither its fill"),
        (result_coin(&buy, 0, FORK, 43_999), "neither its fill"),
    ] {
        let refusal = refused(coin);
        assert!(refusal.message.contains(why), "{}", refusal.message);
    }
    let mut other_pool = result_coin(&buy, 0, FORK, 44_482);
    other_pool["result"]["pools"][0]["fee_millionths"] = json!(1);
    assert!(refused(other_pool).message.contains("not the"));

    // The Decoder checks the evidence apart from the builder: a bad word for a spent result is refused.
    let good = send(FORK, 30_000, vec![ecx_coin(4, 100_000), result_coin(&buy, 0, FORK, 44_482)]);
    let psbt = Psbt::from_str(&build_transfer(&good, STARTER).unwrap().pset).unwrap();
    let refusal = decode_with_evidence(&psbt.to_string(), STARTER, &evidence(&buy, 0, BROSEVELT, 44_482).to_string()).unwrap_err();
    assert_eq!(refusal.code, RefusalCode::InvalidEvidence);
    // With the right word, the transfer carries on exactly what the result holds. Had the index
    // overstated it, the node would refuse the transfer (`bad-ba-tokens-unbacked`): nothing is lost.
    let view = clear(decoded(&psbt, &evidence(&buy, 0, FORK, 44_482)));
    assert_eq!(view.outputs.iter().filter(|o| o.asset == FORK).map(|o| o.amount.parse::<u64>().unwrap()).sum::<u64>(), 44_482);
}

#[test]
fn a_result_with_no_claim_is_never_spent() {
    let refusal = build_transfer(&send(FORK, 100, vec![ecx_coin(4, 100_000), json!({ "tx": buy(), "vout": 0, "chain": 0, "index": 0 })]), STARTER).unwrap_err();
    assert_eq!(refusal.code, RefusalCode::InsufficientFunds);
}
