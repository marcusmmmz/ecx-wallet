//! `l1.wasm`: the L1 Chain Module behind the shared C ABI (see `ecx-wasm-abi`).
//! Thin by design: every function only decodes its inputs, calls `ecx_l1` and returns JSON.
//! It holds nothing between calls; the L1 Account Key arrives per call and is the only secret it sees.
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
    ret_text(json(&ecx_l1::declare()))
}

/// eCash's Chain Entry, as JSON.
#[no_mangle]
pub extern "C" fn chain_entry() -> i32 {
    ret_text(json(ecx_l1::chain_entry()))
}

/// L1 Account Key + how many receive and change addresses → the account (descriptor, addresses),
/// as JSON.
#[no_mangle]
pub unsafe extern "C" fn derive_account(key: *const u8, key_len: usize, receive: u32, change: u32) -> i32 {
    ret_text(text(key, key_len).and_then(|k| ecx_l1::derive_account(k, receive, change)).and_then(|a| json(&a)))
}

/// A refusal travels as the error result, as JSON (`{ code, message }`), so the host can tell
/// which rule refused the request.
fn refusal(r: ecx_l1::Refusal) -> String {
    json(&r).unwrap_or(r.message)
}

/// Slot → its Treasury script on this network, hex.
#[no_mangle]
pub extern "C" fn treasury_script(slot: u32) -> i32 {
    ret_text(ecx_l1::treasury_script(slot))
}

/// Raw transaction (hex) → its txid.
#[no_mangle]
pub unsafe extern "C" fn txid(tx: *const u8, tx_len: usize) -> i32 {
    ret_text(text(tx, tx_len).and_then(ecx_l1::txid))
}

/// Deposit order (JSON) + L1 Account Key → `{ psbt, spent }` (an unsigned M5 and the account's coins
/// it spends) as JSON, or a refusal.
#[no_mangle]
pub unsafe extern "C" fn build_deposit(order: *const u8, order_len: usize, key: *const u8, key_len: usize) -> i32 {
    ret_text(text(order, order_len).and_then(|o| {
        let k = text(key, key_len)?;
        ecx_l1::build_deposit(o, k).map_err(refusal).and_then(|b| json(&b))
    }))
}

/// Transfer order (JSON) + L1 Account Key → `{ pset, spent }` (an unsigned PSBT and the coins it
/// spends) as JSON, or a refusal.
#[no_mangle]
pub unsafe extern "C" fn build_transfer(order: *const u8, order_len: usize, key: *const u8, key_len: usize) -> i32 {
    ret_text(text(order, order_len).and_then(|o| {
        let k = text(key, key_len)?;
        ecx_l1::build_transfer(o, k).map_err(refusal).and_then(|b| json(&b))
    }))
}

/// Base64 PSBT → `null` if it passes the refusals that need no key, or a refusal.
#[no_mangle]
pub unsafe extern "C" fn check(payload: *const u8, payload_len: usize) -> i32 {
    ret_text(text(payload, payload_len).and_then(|p| ecx_l1::check(p).map_err(refusal).map(|()| "null".into())))
}

/// Base64 PSBT + L1 Account Key (+ the request's evidence, which no L1 kind uses yet: ignored) →
/// `{ kind: "clear", view }` or `{ kind: "blind", reason, verifiableFacts }` as JSON, or a refusal.
#[no_mangle]
pub unsafe extern "C" fn decode(
    payload: *const u8,
    payload_len: usize,
    key: *const u8,
    key_len: usize,
    _evidence: *const u8,
    _evidence_len: usize,
) -> i32 {
    ret_text(text(payload, payload_len).and_then(|p| {
        let k = text(key, key_len)?;
        ecx_l1::decode(p, k).map_err(refusal).and_then(|d| json(&d))
    }))
}

/// Base64 PSBT + L1 Account Key → the same PSBT (base64) with signatures on the owned inputs, or a
/// refusal (a spend without the replay marker among them).
#[no_mangle]
pub unsafe extern "C" fn sign(payload: *const u8, payload_len: usize, key: *const u8, key_len: usize) -> i32 {
    ret_text(text(payload, payload_len).and_then(|p| {
        let k = text(key, key_len)?;
        ecx_l1::sign(p, k).map_err(refusal)
    }))
}

/// Signed base64 PSBT → `{ tx, txid }` (the raw transaction, hex) as JSON, or a refusal.
#[no_mangle]
pub unsafe extern "C" fn finalize(payload: *const u8, payload_len: usize) -> i32 {
    ret_text(text(payload, payload_len).and_then(|p| ecx_l1::finalize(p).map_err(refusal).and_then(|f| json(&f))))
}
