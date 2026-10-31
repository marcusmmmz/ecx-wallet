//! What every L1 PSBT goes through first, in `check`, `decode`, `sign` and `finalize`: it parses,
//! it carries the replay marker, and every input carries the whole transaction it spends.
//!
//! The replay marker is the v0 invariant (docs/adr/0004): `nLockTime` is the network's
//! `replayLockTime` and every input's `nSequence` is non-final. Without it a spend is valid on
//! Bitcoin too, so the module never signs one.
//!
//! The previous transactions are what let the Decoder vouch for the amounts: each one hashes to the
//! txid its input names, so the server that supplied it can't change a value or a script.
use std::str::FromStr;

use bitcoin::psbt::Psbt;
use bitcoin::script::{Instruction, Script};
use bitcoin::{ScriptBuf, Sequence, TxOut};
use serde::Serialize;

use crate::network;

/// Why the module won't decode, sign or finalize a request.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Refusal {
    pub code: RefusalCode,
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RefusalCode {
    /// Not a PSBT, or not one this module can read or complete.
    Malformed,
    /// An input without the transaction it spends (`non_witness_utxo`).
    MissingInputFields,
    /// Not replay-marked: the `nLockTime` isn't the network's, or an input's `nSequence` is final.
    NoReplayMarker,
    /// The key handed in isn't an L1 Account Key (a wallet bug, not the requester's).
    InvalidAccountKey,
    /// `build_deposit`: the coins don't cover the amount and its fee.
    InsufficientFunds,
    /// `build_deposit`: the M5 would take more coins than eCash relays a Deposit with (vB).
    TooLarge,
}

pub(crate) fn refuse(code: RefusalCode, message: impl Into<String>) -> Refusal {
    Refusal { code, message: message.into() }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetAmount {
    /// Always "": eCash has no assets, only its coin (the wallet's `NATIVE_COIN`).
    pub asset: String,
    /// Sats, as a decimal string.
    pub amount: String,
}

impl AssetAmount {
    pub(crate) fn sats(amount: impl ToString) -> Self {
        AssetAmount { asset: String::new(), amount: amount.to_string() }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OwnedInput {
    pub index: usize,
    /// Always "".
    pub asset: String,
    /// Sats, as a decimal string.
    pub amount: String,
}

/// Parses `payload` (base64) and applies the module's refusals, in order.
pub(crate) fn validated(payload: &str) -> Result<Psbt, Refusal> {
    let psbt = Psbt::from_str(payload).map_err(|e| refuse(RefusalCode::Malformed, format!("The payload is not a PSBT: {e}")))?;
    let tx = &psbt.unsigned_tx;
    if tx.input.is_empty() || tx.output.is_empty() {
        return Err(refuse(RefusalCode::Malformed, "The transaction has no inputs or no outputs."));
    }

    let replay = network().params.replay_lock_time;
    if tx.lock_time.to_consensus_u32() != replay {
        return Err(refuse(
            RefusalCode::NoReplayMarker,
            format!("The transaction isn't replay-protected: its nLockTime is {}, not this network's {replay}.", tx.lock_time.to_consensus_u32()),
        ));
    }
    if let Some(i) = tx.input.iter().position(|input| input.sequence == Sequence::MAX) {
        return Err(refuse(RefusalCode::NoReplayMarker, format!("The transaction isn't replay-protected: input {i}'s nSequence is final.")));
    }

    for (i, (txin, input)) in tx.input.iter().zip(&psbt.inputs).enumerate() {
        let previous = input
            .non_witness_utxo
            .as_ref()
            .ok_or_else(|| refuse(RefusalCode::MissingInputFields, format!("Input {i} has no non_witness_utxo.")))?;
        if previous.compute_txid() != txin.previous_output.txid {
            return Err(refuse(RefusalCode::Malformed, format!("Input {i}'s non_witness_utxo isn't the transaction it spends.")));
        }
        let spent = previous
            .output
            .get(txin.previous_output.vout as usize)
            .ok_or_else(|| refuse(RefusalCode::Malformed, format!("Input {i} spends an output its transaction doesn't have.")))?;
        if input.witness_utxo.as_ref().is_some_and(|utxo| utxo != spent) {
            return Err(refuse(RefusalCode::Malformed, format!("Input {i}'s witness_utxo isn't the output it spends.")));
        }
    }
    Ok(psbt)
}

/// The output input `i` spends. Only for a PSBT that passed [`validated`].
pub(crate) fn spent(psbt: &Psbt, i: usize) -> &TxOut {
    let outpoint = psbt.unsigned_tx.input[i].previous_output;
    &psbt.inputs[i].non_witness_utxo.as_ref().expect("validated").output[outpoint.vout as usize]
}

/// The refusals that need no key, so the wallet can refuse before asking the user to unlock.
/// `decode`, `sign` and `finalize` run them again.
pub fn check(payload: &str) -> Result<(), Refusal> {
    validated(payload).map(|_| ())
}

/// The Slot whose Treasury `script` is: exactly `OP_DRIVECHAIN OP_PUSHBYTES_1 <slot> OP_TRUE`,
/// with this network's `OP_DRIVECHAIN` (the enforcer's `OpDrivechain::parse`).
pub(crate) fn treasury_slot(script: &Script) -> Option<u8> {
    let opcode = network().params.op_drivechain.opcode();
    match script.as_bytes() {
        [op, 0x01, slot, 0x51] if *op == opcode => Some(*slot),
        _ => None,
    }
}

/// The Treasury script of `slot` on this network.
pub(crate) fn treasury_script_of(slot: u8) -> ScriptBuf {
    ScriptBuf::from_bytes(vec![network().params.op_drivechain.opcode(), 0x01, slot, 0x51])
}

/// The data of an `OP_RETURN` with exactly one push, as an M5's deposit address is (the enforcer's
/// `try_parse_op_return_address`); None for any other script.
pub(crate) fn op_return_data(script: &Script) -> Option<Vec<u8>> {
    let mut instructions = script.instructions();
    let Some(Ok(Instruction::Op(bitcoin::opcodes::all::OP_RETURN))) = instructions.next() else { return None };
    let Some(Ok(Instruction::PushBytes(data))) = instructions.next() else { return None };
    instructions.next().is_none().then(|| data.as_bytes().to_vec())
}
