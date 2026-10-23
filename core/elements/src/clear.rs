//! The Elements Decoder: a Clear View of a request it fully understands, or the reason it can't
//! give one (the request is then Blind; never a partial Clear View).
//!
//! Hand-written: LWK's `pset_balance` refuses owned explicit inputs and outputs. Whether an input or
//! output is "yours" is decided only by re-deriving it (`ownership.rs`), never by the requester.
use std::str::FromStr;

use elements_miniscript::elements::pset::{Input, Output, PartiallySignedTransaction};
use elements_miniscript::elements::script::Instruction;
use bech32::{segwit, Fe32, Hrp};
use elements_miniscript::bitcoin::base58;
use elements_miniscript::elements::hashes::Hash;
use elements_miniscript::elements::secp256k1_zkp::ZERO_TWEAK;
use elements_miniscript::elements::{Address, AssetId, ContractHash, Txid};
use serde::Serialize;

use crate::account::address_params;
use crate::classify::{Classified, OutputKind, Sighash};
use crate::decode::AssetAmount;
use crate::network;

/// What the user is shown for a request the Decoder fully understands.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClearView {
    /// Risky modes, to be shown above everything else.
    pub dangerous_modes: Vec<DangerousMode>,
    pub inputs: Vec<ClearInput>,
    /// Every output except the fee.
    pub outputs: Vec<ClearOutput>,
    pub fee: AssetAmount,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClearInput {
    pub index: usize,
    /// Display hex.
    pub asset: String,
    /// Base units, as a decimal string.
    pub amount: String,
    /// Re-derives to this Starter's keys: `sign` signs it.
    pub yours: bool,
    /// The new asset this input issues, if any.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub issuance: Option<ClearIssuance>,
}

/// A new issuance, as the Decoder derives it: the asset and token ids come from the input's
/// outpoint and the contract hash, never from the requester. Amounts are in base units: the
/// precision is in the contract, which the wallet doesn't see.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClearIssuance {
    pub asset: AssetAmount,
    /// The reissuance token, if any. Explicit, so it can never reissue (docs/adr/0008).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token: Option<AssetAmount>,
    /// The committed contract's hash, display hex, if it commits to one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub contract_hash: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClearOutput {
    pub index: usize,
    /// Display hex.
    pub asset: String,
    /// Base units, as a decimal string.
    pub amount: String,
    pub destination: Destination,
}

/// Where an output's funds go.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Destination {
    /// An address on this chain, in its own encoding; `yours` only if it re-derives to the Starter.
    Address { address: String, yours: bool },
    /// A withdrawal burn (how a Withdrawal starts): the amount is destroyed here, and `payout` (the burn
    /// minus `parent_fee`) may be paid on L1 to `l1_script_pubkey` once the withdrawal is accepted.
    #[serde(rename_all = "camelCase")]
    Withdrawal {
        /// The L1 destination as an L1 address (the parent chain's encoding), if it is a standard
        /// script; otherwise only `l1_script_pubkey` says where it goes.
        #[serde(skip_serializing_if = "Option::is_none")]
        l1_address: Option<String>,
        /// Hex.
        l1_script_pubkey: String,
        /// Base units, as a decimal string.
        payout: String,
        /// Base units, as a decimal string.
        parent_fee: String,
    },
}

/// A risky mode of the request.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DangerousMode {
    /// The input's signature commits to less than the whole transaction (anything but ALL), so
    /// others could change what it signs.
    NonDefaultSighash { input: usize, sighash: u32 },
    /// The output burns funds to withdraw them to L1: irreversible, and paid (if ever) only after
    /// the multi-month BIP300 withdrawal vote.
    WithdrawalBurn { output: usize },
}

/// The Clear View of `pset` (already through rules 5-7), or why the Decoder can't give one.
pub(crate) fn clear_view(pset: &PartiallySignedTransaction, classified: &Classified) -> Result<ClearView, String> {
    let global = &pset.global;
    if !global.xpub.is_empty() || global.tx_data.tx_modifiable.is_some() || global.elements_tx_modifiable_flag.is_some() {
        return Err("it has global fields the Decoder doesn't explain.".into());
    }
    if let Some(i) = pset.inputs().iter().position(|input| !only_explained_input_fields(input)) {
        return Err(format!("input {i} has fields the Decoder doesn't explain."));
    }
    if let Some(i) = pset.outputs().iter().position(|output| !only_explained_output_fields(output)) {
        return Err(format!("output {i} has fields the Decoder doesn't explain."));
    }

    let mut dangerous_modes = vec![];
    let mut inputs = vec![];
    for (input, pset_input) in classified.inputs.iter().zip(pset.inputs()) {
        let index = input.index;
        let issuance = issuance(pset_input).map_err(|why| format!("input {index} {why}"))?;
        if input.unproven_claim {
            return Err(format!("input {index} claims one of this wallet's keys, but it doesn't re-derive."));
        }
        match input.sighash {
            Sighash::All => {}
            Sighash::Known(sighash) => dangerous_modes.push(DangerousMode::NonDefaultSighash { input: index, sighash }),
            Sighash::Unknown(sighash) => return Err(format!("input {index} asks for unknown sighash type 0x{sighash:02x}.")),
        }
        inputs.push(ClearInput { index, asset: input.asset.clone(), amount: input.amount.to_string(), yours: input.yours, issuance });
    }

    let mut outputs = vec![];
    for (class, output) in classified.outputs.iter().zip(pset.outputs()) {
        let index = class.index;
        let destination = match class.kind {
            OutputKind::Fee => continue,
            OutputKind::WithdrawalBurn => {
                let withdrawal = withdrawal(output).ok_or_else(|| format!("output {index} is a withdrawal burn it can't fully parse."))?;
                dangerous_modes.push(DangerousMode::WithdrawalBurn { output: index });
                withdrawal
            }
            OutputKind::Script { yours } => {
                let address = Address::from_script(&output.script_pubkey, None, address_params())
                    .ok_or_else(|| format!("output {index} pays a script that isn't an address."))?;
                Destination::Address { address: address.to_string(), yours }
            }
        };
        outputs.push(ClearOutput { index, asset: class.asset.clone(), amount: class.amount.to_string(), destination });
    }

    let policy_asset = &network().params.policy_asset;
    if let Some(other) = classified.fee.keys().find(|asset| *asset != policy_asset) {
        return Err(format!("it pays a fee in asset {other}, not in the chain's policy asset."));
    }
    let fee = classified.fee.get(policy_asset).ok_or("The request has no fee output.")?;
    Ok(ClearView { dangerous_modes, inputs, outputs, fee: AssetAmount { asset: policy_asset.clone(), amount: fee.to_string() } })
}

/// The new issuance `input` makes, if any. A reissuance can't be explained: an explicit token can
/// never reissue, since consensus wants the spent token blinded (docs/adr/0008).
fn issuance(input: &Input) -> Result<Option<ClearIssuance>, String> {
    if !input.has_issuance() {
        return Ok(None);
    }
    if input.issuance_blinding_nonce.is_some_and(|nonce| nonce != ZERO_TWEAK) {
        return Err("reissues an asset.".into());
    }
    let (asset, token) = input.issuance_ids();
    let amount = |asset: AssetId, amount: u64| AssetAmount { asset: asset.to_string(), amount: amount.to_string() };
    Ok(Some(ClearIssuance {
        asset: amount(asset, input.issuance_value_amount.unwrap_or(0)),
        token: input.issuance_inflation_keys.filter(|n| *n > 0).map(|n| amount(token, n)),
        contract_hash: input
            .issuance_asset_entropy
            .filter(|hash| *hash != [0; 32])
            .map(|hash| ContractHash::from_byte_array(hash).to_string()),
    }))
}

/// True if `input` sets nothing beyond what a Clear View shows or `sign` needs. Unknown and
/// proprietary fields are reported (and make the request Blind) before this.
fn only_explained_input_fields(input: &Input) -> bool {
    let rest = Input {
        previous_txid: Txid::all_zeros(),
        previous_output_index: 0,
        sequence: None,
        witness_utxo: None,
        issuance_value_amount: None,
        issuance_inflation_keys: None,
        issuance_asset_entropy: None,
        issuance_blinding_nonce: None,
        bip32_derivation: Default::default(),
        sighash_type: None,
        partial_sigs: Default::default(),
        proprietary: Default::default(),
        unknown: Default::default(),
        ..input.clone()
    };
    rest == Input::default()
}

/// True if `output` sets nothing beyond its explicit asset, amount, script and derivation.
fn only_explained_output_fields(output: &Output) -> bool {
    let rest = Output {
        amount: None,
        asset: None,
        script_pubkey: Default::default(),
        bip32_derivation: Default::default(),
        proprietary: Default::default(),
        unknown: Default::default(),
        ..output.clone()
    };
    rest == Output::default()
}

/// Strictly parses a native-withdrawal burn as this fork's consensus does
/// (`ParseNativeWithdrawalOutput`): `OP_RETURN <parent genesis> <L1 script> <parent fee, BE u64>`,
/// exactly three minimal pushes, the L1 script at most 128 bytes, an explicit pegged-asset amount
/// larger than the parent fee.
fn withdrawal(output: &Output) -> Option<Destination> {
    if output.asset? != AssetId::from_str(&network().params.policy_asset).expect("Chain Entry policy asset is valid") {
        return None;
    }
    let pushes: Vec<&[u8]> = output
        .script_pubkey
        .instructions_minimal()
        .skip(1) // OP_RETURN
        .map(|i| match i {
            Ok(Instruction::PushBytes(bytes)) => Some(bytes),
            _ => None,
        })
        .collect::<Option<_>>()?;
    let [_genesis, l1_script, fee] = pushes[..] else { return None };
    if l1_script.is_empty() || l1_script.len() > 128 {
        return None;
    }
    let parent_fee = u64::from_be_bytes(fee.try_into().ok()?);
    let payout = output.amount?.checked_sub(parent_fee).filter(|p| *p > 0)?;
    Some(Destination::Withdrawal { l1_address: l1_address(l1_script), l1_script_pubkey: hex(l1_script), payout: payout.to_string(), parent_fee: parent_fee.to_string() })
}

/// `script` as an address in the parent chain's encoding (the Chain Entry's
/// `parentAddressParams`): P2PKH and P2SH in base58check, segwit in bech32/bech32m. None for any
/// other script.
fn l1_address(script: &[u8]) -> Option<String> {
    let params = &network().params.parent_address_params;
    let base58 = |prefix: u8, hash: &[u8]| Some(base58::encode_check(&[&[prefix][..], hash].concat()));
    match script {
        [0x76, 0xa9, 0x14, hash @ .., 0x88, 0xac] if hash.len() == 20 => base58(params.p2pkh_prefix, hash),
        [0xa9, 0x14, hash @ .., 0x87] if hash.len() == 20 => base58(params.p2sh_prefix, hash),
        [version @ (0x00 | 0x51..=0x60), len, program @ ..] if *len as usize == program.len() => {
            let version = Fe32::try_from(if *version == 0 { 0 } else { version - 0x50 }).ok()?;
            let hrp = Hrp::parse(&params.bech_hrp).expect("Chain Entry parent bech HRP is valid");
            segwit::encode(hrp, version, program).ok()
        }
        _ => None,
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

