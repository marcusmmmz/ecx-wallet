//! `sign(payload, starter)`: adds this Starter's signatures to the inputs it provably owns, and
//! changes nothing else (unknown fields included). The result is neither finalized nor broadcast.
use lwk_common::Signer;

use crate::decode::{ownership_rules, validated, Refusal, RefusalCode};
use crate::ownership::Wallet;

/// Refuses exactly what `decode` refuses.
pub fn sign(payload: &str, starter: &str) -> Result<String, Refusal> {
    let mut pset = validated(payload)?;
    let wallet = Wallet::new(starter).map_err(|message| Refusal { code: RefusalCode::InvalidStarter, message })?;
    ownership_rules(&pset, &wallet)?;

    // LWK signs a copy in which only the proven entries of owned inputs remain, so nothing else
    // can match its fingerprint check; the signatures are then copied onto the original. An input
    // spending a given-out address gets its entry only in the copy.
    let owned: Vec<_> = pset.inputs().iter().map(|input| wallet.owned_input_key(input)).collect();
    let mut copy = pset.clone();
    for (input, owned) in copy.inputs_mut().iter_mut().zip(&owned) {
        input.tap_key_origins.clear();
        input.bip32_derivation = owned.iter().cloned().collect();
    }
    wallet
        .signer
        .sign(&mut copy)
        .map_err(|e| Refusal { code: RefusalCode::Malformed, message: format!("Can't sign this PSET: {e:?}") })?;

    for ((input, signed), owned) in pset.inputs_mut().iter_mut().zip(copy.inputs()).zip(&owned) {
        if let Some((pk, _)) = owned {
            if let Some(sig) = signed.partial_sigs.get(pk) {
                input.partial_sigs.insert(*pk, sig.clone());
            }
        }
    }
    Ok(pset.to_string())
}
