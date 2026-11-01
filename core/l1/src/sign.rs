//! `sign(payload, account_key)` adds the key's signatures to the inputs it provably owns, and
//! changes nothing else. `finalize(payload)` turns the signed PSBT into the transaction to
//! broadcast. Both run the module's refusals first, so neither ever touches a spend without the
//! replay marker (docs/adr/0004).
use bitcoin::consensus::encode::serialize_hex;
use bitcoin::ecdsa::Signature;
use bitcoin::hashes::Hash;
use bitcoin::psbt::Psbt;
use bitcoin::secp256k1::Message;
use bitcoin::sighash::SighashCache;
use bitcoin::{CompressedPublicKey, EcdsaSighashType, ScriptBuf, Witness};
use serde::Serialize;

use crate::decode::{classify_input, InputKind};
use crate::psbt::{refuse, spent, treasury_slot, validated, Refusal, RefusalCode};
use crate::AccountKeys;

/// Refuses what `decode` refuses, and a PSBT with no input of the key's (`NothingToSign`): it would
/// come back unchanged and fail only at broadcast. Signs P2WPKH inputs with SIGHASH_ALL only.
pub fn sign(payload: &str, account_key: &str) -> Result<String, Refusal> {
    let mut psbt = validated(payload)?;
    let keys = AccountKeys::new(account_key).map_err(|e| refuse(RefusalCode::InvalidAccountKey, e))?;
    let kinds: Vec<_> = (0..psbt.inputs.len()).map(|i| classify_input(&keys, &psbt.inputs[i], spent(&psbt, i))).collect();
    if !kinds.iter().any(|kind| matches!(kind, InputKind::Yours { .. })) {
        return Err(refuse(RefusalCode::NothingToSign, "No input of this PSBT is this wallet's: there is nothing to sign."));
    }

    let mut signatures = vec![];
    let mut cache = SighashCache::new(&psbt.unsigned_tx);
    for (i, kind) in kinds.iter().enumerate() {
        let InputKind::Yours { chain, index, pubkey } = kind else { continue };
        if psbt.inputs[i].sighash_type.is_some_and(|t| t.ecdsa_hash_ty() != Ok(EcdsaSighashType::All)) {
            return Err(refuse(RefusalCode::Malformed, format!("Input {i} asks for a sighash other than ALL, which this wallet doesn't sign.")));
        }
        let spent = spent(&psbt, i);
        let sighash = cache
            .p2wpkh_signature_hash(i, &spent.script_pubkey, spent.value, EcdsaSighashType::All)
            .map_err(|e| refuse(RefusalCode::Malformed, format!("Can't sign input {i}: {e}")))?;
        let secret = keys.secret_key(*chain, *index).map_err(|e| refuse(RefusalCode::InvalidAccountKey, e))?;
        let signature = keys.secp.sign_ecdsa(&Message::from_digest(sighash.to_byte_array()), &secret);
        signatures.push((i, *pubkey, Signature { signature, sighash_type: EcdsaSighashType::All }));
    }
    for (i, pubkey, signature) in signatures {
        psbt.inputs[i].partial_sigs.insert(bitcoin::PublicKey::new(pubkey), signature);
    }
    Ok(psbt.to_string())
}

/// The transaction `finalize` extracted.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Finalized {
    /// The raw transaction, hex: what Esplora's `POST /tx` takes.
    pub tx: String,
    pub txid: String,
}

/// Finalizes every input (BIP174's finalizer) and extracts the transaction. A Treasury input gets
/// its empty scriptSig; a P2WPKH input needs a valid signature from the key its output pays.
/// Anything else is refused: the module only completes what it can check.
pub fn finalize(payload: &str) -> Result<Finalized, Refusal> {
    let mut psbt: Psbt = validated(payload)?;
    let secp = bitcoin::secp256k1::Secp256k1::verification_only();
    let mut cache = SighashCache::new(psbt.unsigned_tx.clone());
    for i in 0..psbt.inputs.len() {
        let spent = spent(&psbt, i).clone();
        let input = &mut psbt.inputs[i];
        if treasury_slot(&spent.script_pubkey).is_some() {
            if input.final_script_sig.as_ref().is_some_and(|script| !script.is_empty()) {
                return Err(refuse(RefusalCode::Malformed, format!("Input {i} spends a Treasury with a scriptSig.")));
            }
            input.final_script_sig = Some(ScriptBuf::new());
        } else if spent.script_pubkey.is_p2wpkh() {
            let pays = |pk: &bitcoin::PublicKey| {
                CompressedPublicKey::try_from(*pk).is_ok_and(|pk| ScriptBuf::new_p2wpkh(&pk.wpubkey_hash()) == spent.script_pubkey)
            };
            let (pubkey, signature) = input
                .partial_sigs
                .iter()
                .find(|(pk, _)| pays(pk))
                .map(|(pk, sig)| (*pk, *sig))
                .ok_or_else(|| refuse(RefusalCode::Malformed, format!("Input {i} isn't signed.")))?;
            let sighash = cache
                .p2wpkh_signature_hash(i, &spent.script_pubkey, spent.value, signature.sighash_type)
                .map_err(|e| refuse(RefusalCode::Malformed, format!("Can't check input {i}'s signature: {e}")))?;
            if signature.sighash_type != EcdsaSighashType::All
                || secp.verify_ecdsa(&Message::from_digest(sighash.to_byte_array()), &signature.signature, &pubkey.inner).is_err()
            {
                return Err(refuse(RefusalCode::Malformed, format!("Input {i}'s signature isn't valid.")));
            }
            input.final_script_witness = Some(Witness::p2wpkh(&signature, &pubkey.inner));
        } else {
            return Err(refuse(RefusalCode::Malformed, format!("Input {i} spends a script this wallet can't finalize.")));
        }
        input.partial_sigs.clear();
        input.bip32_derivation.clear();
        input.sighash_type = None;
    }
    let tx = psbt.extract_tx_unchecked_fee_rate();
    Ok(Finalized { tx: serialize_hex(&tx), txid: tx.compute_txid().to_string() })
}
