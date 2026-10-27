//! `flush.wasm`: the Flush Chain Module behind the shared C ABI (see `ecx-wasm-abi`).
//! Thin by design: every function only decodes its inputs, calls `ecx_flush` and returns JSON.
//! It holds nothing between calls; Flush's Starter arrives per call and is the only secret it sees.
#![allow(clippy::missing_safety_doc)]

use ecx_wasm_abi::{ret_text, text};
use serde::Serialize;

// Re-export the shared ABI so its `#[no_mangle]` functions are linked into this module.
pub use ecx_wasm_abi::{alloc, dealloc, out_clear, out_len, out_ptr};

fn json(value: &impl Serialize) -> Result<String, String> {
    serde_json::to_string(value).map_err(|e| e.to_string())
}

/// The binding (chain, format, payload versions) and capabilities, as JSON.
#[no_mangle]
pub extern "C" fn declare() -> i32 {
    ret_text(json(&ecx_flush::declare()))
}

/// Flush's Chain Entry, as JSON.
#[no_mangle]
pub extern "C" fn chain_entry() -> i32 {
    ret_text(json(ecx_flush::chain_entry()))
}

/// Starter + how many receive and change addresses → the account (descriptor, addresses), as JSON.
#[no_mangle]
pub unsafe extern "C" fn derive_account(starter: *const u8, starter_len: usize, receive: u32, change: u32) -> i32 {
    ret_text(text(starter, starter_len).and_then(|s| ecx_flush::derive_account(s, receive, change)).and_then(|a| json(&a)))
}

/// A refusal travels as the error result, as JSON (`{ code, message }`), so the host can tell
/// which rule refused the request.
fn refusal(r: ecx_flush::Refusal) -> String {
    json(&r).unwrap_or(r.message)
}

/// Transfer order (JSON) + Starter → `{ pset, spent }` (an unsigned PSBT, base64) as JSON, or a refusal.
#[no_mangle]
pub unsafe extern "C" fn build_transfer(order: *const u8, order_len: usize, starter: *const u8, starter_len: usize) -> i32 {
    ret_text(text(order, order_len).and_then(|o| {
        let s = text(starter, starter_len)?;
        ecx_flush::build_transfer(o, s).map_err(refusal).and_then(|b| json(&b))
    }))
}

/// A `flush:` link + the Unix time (decimal text) → the trade it asks for (`{ verb, expires, … }`) as
/// JSON, or a refusal (`invalidAction`, `unsupportedAction`; docs/adr/0016).
#[no_mangle]
pub unsafe extern "C" fn parse_action(link: *const u8, link_len: usize, now: *const u8, now_len: usize) -> i32 {
    ret_text(text(link, link_len).and_then(|l| {
        let now: i64 = text(now, now_len)?.parse().map_err(|_| refusal(ecx_flush::Refusal { code: ecx_flush::RefusalCode::Malformed, message: "now isn't a Unix time".into() }))?;
        ecx_flush::parse_action(l, now).map_err(refusal).and_then(|a| json(&a))
    }))
}

/// Trade order (JSON) + Starter → `{ pset, spent, burn, trade }` as JSON, or a refusal.
#[no_mangle]
pub unsafe extern "C" fn build_trade(order: *const u8, order_len: usize, starter: *const u8, starter_len: usize) -> i32 {
    ret_text(text(order, order_len).and_then(|o| {
        let s = text(starter, starter_len)?;
        ecx_flush::build_trade(o, s).map_err(refusal).and_then(|b| json(&b))
    }))
}

/// Base64 PSBT → `null` if it passes the refusals that need no key, or a refusal.
#[no_mangle]
pub unsafe extern "C" fn check(payload: *const u8, payload_len: usize) -> i32 {
    ret_text(text(payload, payload_len).and_then(|p| ecx_flush::check(p).map_err(refusal).map(|()| "null".into())))
}

/// Base64 PSBT + Starter + the request's evidence (JSON; `pool` for a trade) →
/// `{ kind: "clear", view }` or `{ kind: "blind", reason, verifiableFacts }` as JSON, or a refusal.
#[no_mangle]
pub unsafe extern "C" fn decode(
    payload: *const u8,
    payload_len: usize,
    starter: *const u8,
    starter_len: usize,
    evidence: *const u8,
    evidence_len: usize,
) -> i32 {
    ret_text(text(payload, payload_len).and_then(|p| {
        let s = text(starter, starter_len)?;
        let e = text(evidence, evidence_len)?;
        ecx_flush::decode_with_evidence(p, s, e).map_err(refusal).and_then(|d| json(&d))
    }))
}

/// Base64 PSBT + Starter → the same PSBT (base64) with signatures on the owned inputs, or a refusal.
#[no_mangle]
pub unsafe extern "C" fn sign(payload: *const u8, payload_len: usize, starter: *const u8, starter_len: usize) -> i32 {
    ret_text(text(payload, payload_len).and_then(|p| {
        let s = text(starter, starter_len)?;
        ecx_flush::sign(p, s).map_err(refusal)
    }))
}

/// Signed base64 PSBT → `{ tx, txid }` (the raw transaction, hex) as JSON, or a refusal.
#[no_mangle]
pub unsafe extern "C" fn finalize(payload: *const u8, payload_len: usize) -> i32 {
    ret_text(text(payload, payload_len).and_then(|p| ecx_flush::finalize(p).map_err(refusal).and_then(|f| json(&f))))
}

/// Raw transaction (hex) → `{ txid, outputs: [{ vout, token? }] }`: what its `BAST` marker puts on
/// each output it lists (`token` absent for a result), as JSON, or a refusal.
#[no_mangle]
pub unsafe extern "C" fn output_tokens(tx: *const u8, tx_len: usize) -> i32 {
    ret_text(text(tx, tx_len).and_then(|t| ecx_flush::output_tokens(t).map_err(refusal).and_then(|o| json(&o))))
}

/// Asset id (display hex) + raw transaction (hex) → `{ asset, txid, ticker, name, decimals }` if the
/// transaction registers that asset under a ticker that hashes to it, as JSON, or a refusal.
#[no_mangle]
pub unsafe extern "C" fn asset_registration(asset: *const u8, asset_len: usize, tx: *const u8, tx_len: usize) -> i32 {
    ret_text(text(asset, asset_len).and_then(|a| {
        let t = text(tx, tx_len)?;
        ecx_flush::asset_registration(a, t).map_err(refusal).and_then(|r| json(&r))
    }))
}

/// Asset id (display hex) + raw transaction (hex) → `{ asset, txid, mime, bytes }` if the
/// transaction sets that asset's logo to an image the wallet shows, as JSON, or a refusal.
#[no_mangle]
pub unsafe extern "C" fn asset_logo(asset: *const u8, asset_len: usize, tx: *const u8, tx_len: usize) -> i32 {
    ret_text(text(asset, asset_len).and_then(|a| {
        let t = text(tx, tx_len)?;
        ecx_flush::asset_logo(a, t).map_err(refusal).and_then(|l| json(&l))
    }))
}

/// Starter → `{ address, destination, asset, minimum, scriptPubkey }` as JSON: what a Deposit is
/// credited to. Fails while the Chain Entry pins no activation (`declare` lists it only then).
#[no_mangle]
pub unsafe extern "C" fn deposit_destination(starter: *const u8, starter_len: usize) -> i32 {
    ret_text(text(starter, starter_len).and_then(ecx_flush::deposit_destination).and_then(|d| json(&d)))
}
