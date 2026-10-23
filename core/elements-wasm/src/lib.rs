//! `elements.wasm`: the Elements Chain Module behind the shared C ABI (see `ecx-wasm-abi`).
//! Thin by design: every function only decodes its inputs, calls `ecx_elements` and returns JSON.
//! It holds nothing between calls; the Starter arrives per call and is the only secret it sees.
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
    ret_text(json(&ecx_elements::declare()))
}

/// Slot 24's Chain Entry, as JSON.
#[no_mangle]
pub extern "C" fn chain_entry() -> i32 {
    ret_text(json(ecx_elements::chain_entry()))
}

/// Slot 24 Starter + how many receive and change addresses → the account (descriptor, addresses),
/// as JSON.
#[no_mangle]
pub unsafe extern "C" fn derive_account(starter: *const u8, starter_len: usize, receive: u32, change: u32) -> i32 {
    ret_text(text(starter, starter_len).and_then(|s| ecx_elements::derive_account(s, receive, change)).and_then(|a| json(&a)))
}

/// Slot 24 Starter → `{ address, destination, asset, minimum }` (what a Deposit is credited to)
/// as JSON.
#[no_mangle]
pub unsafe extern "C" fn deposit_destination(starter: *const u8, starter_len: usize) -> i32 {
    ret_text(text(starter, starter_len).and_then(ecx_elements::deposit_destination).and_then(|d| json(&d)))
}

/// A refusal travels as the error result, as JSON (`{ code, message }`), so the host can tell
/// which rule refused the request.
fn refusal(r: ecx_elements::Refusal) -> String {
    json(&r).unwrap_or(r.message)
}

/// Base64 PSET → `null` if it passes the refusals that need no Starter, or a refusal.
#[no_mangle]
pub unsafe extern "C" fn check(payload: *const u8, payload_len: usize) -> i32 {
    ret_text(text(payload, payload_len).and_then(|p| ecx_elements::check(p).map_err(refusal).map(|()| "null".into())))
}

/// Base64 PSET + Slot 24 Starter + the request's evidence (JSON, `{}` for none) →
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
        let e = ecx_elements::Evidence::from_json(text(evidence, evidence_len)?).map_err(refusal)?;
        ecx_elements::decode(p, s, &e).map_err(refusal).and_then(|d| json(&d))
    }))
}

/// Base64 PSET + Slot 24 Starter → the same PSET (base64) with signatures on the owned inputs, or
/// a refusal.
#[no_mangle]
pub unsafe extern "C" fn sign(payload: *const u8, payload_len: usize, starter: *const u8, starter_len: usize) -> i32 {
    ret_text(text(payload, payload_len).and_then(|p| {
        let s = text(starter, starter_len)?;
        ecx_elements::sign(p, s).map_err(refusal)
    }))
}

/// Asset id + its issuance's outpoint (txid, vout) + contract JSON → `{ asset, name, ticker,
/// precision, domain }` as JSON, or a refusal (`invalidContract`). Needs no Starter.
#[no_mangle]
pub unsafe extern "C" fn asset_contract(
    asset: *const u8,
    asset_len: usize,
    txid: *const u8,
    txid_len: usize,
    vout: u32,
    contract: *const u8,
    contract_len: usize,
) -> i32 {
    ret_text(text(asset, asset_len).and_then(|a| {
        let (t, c) = (text(txid, txid_len)?, text(contract, contract_len)?);
        ecx_elements::asset_contract(a, t, vout, c).map_err(refusal).and_then(|checked| json(&checked))
    }))
}

/// Transfer order (JSON) + Slot 24 Starter → `{ pset }` (base64, unsigned) as JSON, or a refusal
/// (`insufficientFunds`, `dust`, `confidential`, …).
#[no_mangle]
pub unsafe extern "C" fn build_transfer(order: *const u8, order_len: usize, starter: *const u8, starter_len: usize) -> i32 {
    ret_text(text(order, order_len).and_then(|o| {
        let s = text(starter, starter_len)?;
        ecx_elements::build_transfer(o, s).map_err(refusal).and_then(|b| json(&b))
    }))
}

/// Signed base64 PSET → `{ tx, txid }` (the raw transaction, hex) as JSON, or a refusal.
#[no_mangle]
pub unsafe extern "C" fn finalize(payload: *const u8, payload_len: usize) -> i32 {
    ret_text(text(payload, payload_len).and_then(|p| ecx_elements::finalize(p).map_err(refusal).and_then(|f| json(&f))))
}
