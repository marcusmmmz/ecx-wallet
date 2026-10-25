//! What every Flush PSBT goes through first, in `check`, `decode`, `sign` and `finalize`: it parses,
//! and every input carries the whole transaction it spends. L1's rules (`core/l1/src/psbt.rs`)
//! without the replay marker: Flush has its own genesis, so no spend of it is valid elsewhere
//! (docs/adr/0011).
//!
//! The previous transactions are what let the Decoder vouch for the amounts: each one hashes to the
//! txid its input names, so the server or app that supplied it can't change a value or a script.
use std::str::FromStr;

use bitcoin::psbt::Psbt;
use bitcoin::script::{Instruction, Script};
use bitcoin::TxOut;
use serde::Serialize;

/// Why the module won't build, decode, sign or finalize a request.
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
    /// No input is the Starter's: signing would change nothing (docs/adr/0007).
    NothingToSign,
    /// The key handed in isn't a Starter (a wallet bug, not the requester's).
    InvalidStarter,
    /// `build_transfer`: the coins don't cover the amounts and the fee.
    InsufficientFunds,
    /// `build_transfer`: an amount is below what Flush relays.
    Dust,
    /// `asset_registration`: the transaction isn't the asset's registration, or names it no ticker.
    InvalidContract,
}

pub(crate) fn refuse(code: RefusalCode, message: impl Into<String>) -> Refusal {
    Refusal { code, message: message.into() }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetAmount {
    /// Always "": the Decoder only counts ECX, the native coin (the wallet's `NATIVE_COIN`).
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

/// The Flush operation an `OP_RETURN` output marks: its first push starts with the operation's
/// 4-byte tag. None for any other `OP_RETURN`. The tags are backbone-flush's at `48e822b`:
/// `src/bitassets/state.h` (`BAST`), `src/pos/{bond,evidence,feesplit,header}.h` (staking and
/// blocks of stake) and `src/sidechain/state.h` (withdrawals).
pub(crate) fn operation(script: &Script) -> Option<&'static str> {
    const OPERATIONS: [([u8; 4], &str); 10] = [
        (*b"BAST", "a token or DEX operation"),
        ([0xDB, b'S', b'T', b'K'], "a stake bond"),
        ([0xDC, b'U', b'N', b'B'], "a stake unbond"),
        ([0xDD, b'E', b'V', b'D'], "validator evidence"),
        ([0xDE, b'V', b'P', b'L'], "a validator pool"),
        ([0xDE, b'V', b'P', b'S'], "validator shares"),
        ([0xDE, b'P', b'O', b'T'], "a block header"),
        ([0xD8, b'W', b'D', b'R'], "a withdrawal to eCash"),
        ([0xD9, b'R', b'F', b'N'], "a withdrawal refund"),
        ([0xDA, b'B', b'N', b'D'], "a withdrawal bundle"),
    ];
    let mut instructions = script.instructions();
    let Some(Ok(Instruction::Op(bitcoin::opcodes::all::OP_RETURN))) = instructions.next() else { return None };
    let Some(Ok(Instruction::PushBytes(data))) = instructions.next() else { return None };
    OPERATIONS.iter().find(|(tag, _)| data.as_bytes().starts_with(tag)).map(|(_, name)| *name)
}
