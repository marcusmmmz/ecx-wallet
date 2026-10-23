//! Seam 2: the Elements Chain Module, through its public interface only.
//!
//! Address fixtures were computed independently of this crate, in the LWK 0.19.0 probe used for
//! the spec's research notes, from the Slot 24 Starter of "abandon … about" with no passphrase
//! (itself a BitWindow `DeriveStarter` vector, see core/vault/tests/vault.rs).
mod common;

use common::hex_bytes;
use ecx_elements::chain_entry::{check_chain_entry, CHAIN_ENTRY_JSON};
use ecx_elements::{chain_entry, declare, derive_account, ChainEntry, ServerApi};

/// The Slot 24 Starter of "abandon … about", no passphrase.
const STARTER: &str = "buyer citizen congress doll secret merry denial law live wait pass drive";

#[test]
fn the_slot_24_starter_derives_lwk_standard_wpkh_receive_addresses_in_elements_encoding() {
    let account = derive_account(STARTER, 2, 0).unwrap();
    let addresses: Vec<_> = account.receive.iter().map(|a| (a.index, a.address.as_str())).collect();
    assert_eq!(
        addresses,
        vec![
            (0, "elements1qew44aehkjstjm56ng2rjrz57vwxh5g9su6dlpm"),
            (1, "elements1qnx6kczxpu35ypahwhqddx2pn6q0nuyaap97ygn"),
        ]
    );
}

#[test]
fn the_slot_24_starter_derives_change_addresses_on_the_internal_chain() {
    // Computed independently (plain BIP32/BIP84 + bech32 with the Chain Entry's `elements` HRP),
    // which also reproduces the receive vectors above.
    let account = derive_account(STARTER, 1, 2).unwrap();
    let change: Vec<_> = account.change.iter().map(|a| (a.index, a.address.as_str(), a.script_pubkey.as_str())).collect();
    assert_eq!(
        change,
        vec![
            (0, "elements1q2n6usykz5ycrnfpup3hx0qa0manae07jgvvmuc", "001454f5c812c2a13039a43c0c6e6783afdf67dcbfd2"),
            (1, "elements1q76a5rhnaglcfqz9t73rrh3jerxw76xlm6rvth3", "0014f6bb41de7d47f09008abf4463bc659199ded1bfb"),
        ]
    );
    assert_eq!(account.receive.len(), 1);
}

#[test]
fn the_watch_data_is_the_explicit_wpkh_descriptor_on_lwks_non_mainnet_default_path() {
    let account = derive_account(STARTER, 1, 0).unwrap();
    assert_eq!(
        account.descriptor,
        "elwpkh([3b27f87d/84h/1h/0h]tpubDDL3PFxTGwYoTxQHpMfqnwzdZoPHtAxpSnXWkQAfV1eQutNJss45qjiXwTYwzNfmi1a63E4M3Q4v4FPw2xzf4ztGDanQJqndsAAYVRnYixi/<0;1>/*)"
    );
}

#[test]
fn each_address_carries_the_compressed_public_key_its_script_pays() {
    use elements_miniscript::elements::hashes::{hash160, Hash};
    let account = derive_account(STARTER, 2, 1).unwrap();
    for entry in account.receive.iter().chain(&account.change) {
        let pk = hex_bytes(&entry.public_key);
        assert_eq!(pk.len(), 33, "compressed");
        let script = [&[0x00, 0x14][..], hash160::Hash::hash(&pk).as_byte_array()].concat();
        assert_eq!(entry.script_pubkey, script.iter().map(|b| format!("{b:02x}")).collect::<String>());
    }
}

#[test]
fn a_different_starter_derives_different_addresses() {
    let other = derive_account("blush cream bullet drive index disease noble east target dice put rate", 1, 0).unwrap();
    assert_ne!(other.receive[0].address, "elements1qew44aehkjstjm56ng2rjrz57vwxh5g9su6dlpm");
    assert!(other.receive[0].address.starts_with("elements1q"));
}

#[test]
fn a_deposit_is_credited_to_the_first_receive_address_written_out_in_utf8() {
    let d = ecx_elements::deposit_destination(STARTER).unwrap();
    assert_eq!(d.address, "elements1qew44aehkjstjm56ng2rjrz57vwxh5g9su6dlpm");
    assert_eq!(d.destination, d.address.bytes().map(|b| format!("{b:02x}")).collect::<String>());
    assert_eq!(d.asset, "5836dcc06130dcf6a65b6ac493813fd65559955283e44cc3f07966294eccb2c8", "the pegged asset");
    assert_eq!(d.minimum, "3000");
    assert!(ecx_elements::deposit_destination("not a mnemonic").is_err());
}

#[test]
fn slot_24s_betanet_activation_is_pinned() {
    let activation = ecx_elements::network().activation.as_ref().unwrap();
    assert_eq!(activation.height, 970_715);
    assert_eq!(activation.hash, "000000000000000094c4b58e192ea0105c5e82c3eaf168ab53090254bc9a3c3c");
}

#[test]
fn slot_24s_betanet_deposits_are_credited_after_6_confirmations() {
    assert_eq!(ecx_elements::network().deposit_confirmations, Some(6));
}

#[test]
fn something_that_is_not_a_starter_is_refused() {
    assert!(derive_account("not a mnemonic", 1, 0).is_err());
}

#[test]
fn declare_reports_the_betanet_slot_24_binding_for_psets() {
    let d = declare();
    assert_eq!(d.binding.chain, "ecash:betanet-s24");
    assert_eq!(d.binding.format, "pset");
    assert_eq!(d.binding.payload_versions, vec!["1".to_string()]);
    assert_eq!(d.capabilities, ["depositDestination", "buildTransfer"]);
}

#[test]
fn betanet_reads_its_state_from_the_elements_explorers_esplora() {
    let server = &chain_entry().networks["betanet"].sidechain_server;
    assert_eq!(server.api, ServerApi::Esplora);
    assert_eq!(server.url, "https://explorer.bitnames.info/api");
}

#[test]
fn betanet_is_a_child_of_ecash_betanet_identified_by_its_genesis() {
    let network = &chain_entry().networks["betanet"];
    assert_eq!(chain_entry().slot, Some(24));
    assert_eq!(network.parent.as_deref(), Some("ecash:betanet"));
    // Elements isn't a fork: the identity block is its own genesis.
    assert_eq!((network.identity_block.height, network.identity_block.hash.as_str()), (0, network.params.genesis_hash.as_str()));
}

#[test]
fn betanet_names_its_policy_asset_as_its_ecx() {
    let network = &chain_entry().networks["betanet"];
    assert_eq!(chain_entry().name, "Elements+");
    let ecx = network.ecx_asset().expect("betanet names its ECX");
    assert_eq!(ecx.id, network.params.policy_asset);
    assert_eq!((ecx.ticker.as_str(), ecx.name.as_str(), ecx.decimals), ("ECX", "eCash on Elements+", 8));
}

#[test]
fn a_chain_entry_whose_ecx_isnt_the_policy_asset_is_refused() {
    let mut entry: serde_json::Value = serde_json::from_str(CHAIN_ENTRY_JSON).unwrap();
    entry["networks"]["betanet"]["assets"][0]["id"] = "11".repeat(32).into();
    let entry: ChainEntry = serde_json::from_value(entry).unwrap();
    assert!(check_chain_entry(&entry).unwrap_err().contains("policy asset"));
}

/// The shipped Chain Entry with betanet's `sidechainServer` replaced.
fn with_server(server: serde_json::Value) -> Result<ChainEntry, serde_json::Error> {
    let mut entry: serde_json::Value = serde_json::from_str(CHAIN_ENTRY_JSON).unwrap();
    entry["networks"]["betanet"]["sidechainServer"] = server;
    serde_json::from_value(entry)
}

#[test]
fn a_chain_entry_must_name_a_known_server_api() {
    let url = "https://server.invalid";
    assert!(with_server(serde_json::json!({ "api": "ecx-v0", "url": url })).is_ok());
    assert!(with_server(serde_json::json!({ "api": "esplora", "url": url })).is_ok());
    assert!(with_server(serde_json::json!({ "url": url })).is_err(), "no default API");
    assert!(with_server(serde_json::json!({ "api": "electrum", "url": url })).is_err());
    assert!(with_server(serde_json::json!(url)).is_err(), "a bare URL names no API");
}
