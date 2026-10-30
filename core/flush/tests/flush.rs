//! Seam 2: the Flush Chain Module, through its public interface only.
//!
//! The keys are LWK's, from the Elements module's vectors (core/elements/tests/elements.rs): the
//! same Starter at the same path, `m/84'/1'/0'`, so the same fingerprint, xpub and scripts. The
//! addresses re-encode those scripts' programs with `bflx` by BIP173's reference algorithm.
mod common;

use common::STARTER;
use ecx_flush::chain_entry::{check_chain_entry, ChainEntry, CHAIN_ENTRY_JSON};
use ecx_flush::{chain_entry, declare, derive_account, network, ServerApi};

#[test]
fn the_starter_derives_bip84_receive_and_change_addresses_in_flush_encoding() {
    let account = derive_account(STARTER, 2, 1).unwrap();
    let receive: Vec<_> = account.receive.iter().map(|a| (a.index, a.address.as_str())).collect();
    assert_eq!(receive, [(0, "bflx1qew44aehkjstjm56ng2rjrz57vwxh5g9sf7mzp4"), (1, "bflx1qnx6kczxpu35ypahwhqddx2pn6q0nuyaa5pgega")]);
    let change = &account.change[0];
    assert_eq!((change.address.as_str(), change.script_pubkey.as_str()), ("bflx1q2n6usykz5ycrnfpup3hx0qa0manae07jag6xuk", "001454f5c812c2a13039a43c0c6e6783afdf67dcbfd2"));
}

#[test]
fn the_watch_data_is_the_wpkh_descriptor_on_the_non_mainnet_path() {
    // Flush Core's own wallet derives at 84h/1h/0h on every network but mainnet (src/wallet/walletutil.cpp).
    let account = derive_account(STARTER, 0, 0).unwrap();
    assert_eq!(
        account.descriptor,
        "wpkh([3b27f87d/84h/1h/0h]tpubDDL3PFxTGwYoTxQHpMfqnwzdZoPHtAxpSnXWkQAfV1eQutNJss45qjiXwTYwzNfmi1a63E4M3Q4v4FPw2xzf4ztGDanQJqndsAAYVRnYixi/<0;1>/*)"
    );
}

#[test]
fn each_address_carries_the_compressed_public_key_its_script_pays() {
    let account = derive_account(STARTER, 1, 1).unwrap();
    for entry in account.receive.iter().chain(&account.change) {
        assert_eq!(entry.public_key.len(), 66);
        assert!(entry.public_key.starts_with("02") || entry.public_key.starts_with("03"));
    }
}

#[test]
fn refuses_anything_but_a_starter() {
    let l1_key = "[73c5da0a/84h/0h/0h]xprv9xxx";
    for bad in ["", "not a mnemonic", l1_key, "abandon abandon abandon"] {
        let error = derive_account(bad, 1, 0).unwrap_err();
        assert!(error.contains("invalid Starter"), "{bad}: {error}");
    }
}

#[test]
fn declare_reports_slot_99s_betanet_binding_and_capabilities() {
    let d = declare();
    assert_eq!(d.binding.chain, "ecash:betanet-s99");
    assert_eq!(d.binding.format, "psbt");
    assert_eq!(d.binding.payload_versions, ["0"]);
    assert_eq!(d.capabilities, ["buildTransfer", "tokens", "trades", "depositDestination"]);
}

#[test]
fn flush_on_betanet_is_slot_99_identified_by_its_own_genesis() {
    assert_eq!(network().slot, Some(99));
    assert_eq!(chain_entry().name, "Flush");
    let betanet = network();
    assert_eq!(betanet.parent.as_deref(), Some("ecash:betanet"));
    assert_eq!(betanet.identity_block.height, 0);
    assert_eq!(betanet.identity_block.hash, "04dfb01bef61e44d679132f9e830719c64241f7052880418a350ff6d3c90b561");
    let activation = betanet.activation.as_ref().expect("Slot 99 is active on betanet");
    assert_eq!((activation.height, activation.hash.as_str()), (968_998, "00000000000000012009a14359125c30ad531aa58fdcc76eee7d14c522acd5ae"));
    assert_eq!(betanet.deposit_confirmations, Some(2));
    assert_eq!(betanet.sidechain_server.api, ServerApi::Flush);
    let p = &betanet.params.address_params;
    assert_eq!((p.p2pkh_prefix, p.p2sh_prefix, p.bech_hrp.as_str()), (0, 5, "bflx"));
}

#[test]
fn flush_on_mainnet_is_slot_46_active_from_block_978_331() {
    let mainnet = &chain_entry().networks["mainnet"];
    assert_eq!((mainnet.chain.as_str(), mainnet.slot, mainnet.parent.as_deref()), ("ecash:mainnet-s46", Some(46), Some("ecash:mainnet")));
    assert_eq!(mainnet.identity_block.height, 0);
    assert_eq!(mainnet.identity_block.hash, "19b25cff92c2beec1032a50d1eff87b01e1d67e658e25ca099fe599213843662");
    let activation = mainnet.activation.as_ref().expect("Slot 46 is active on mainnet (docs/adr/0019)");
    assert_eq!((activation.height, activation.hash.as_str()), (978_331, "000000000000000021edfa06433c6e13d6a06d026d6fdc26b3b894e8b4bf1f65"));
    assert_eq!(mainnet.deposit_confirmations, Some(2));
    assert_eq!(mainnet.sidechain_server.api, ServerApi::Flush);
    let p = &mainnet.params.address_params;
    assert_eq!((p.p2pkh_prefix, p.p2sh_prefix, p.bech_hrp.as_str()), (0, 5, "flx"));
}

#[test]
fn flushs_ecx_is_its_native_coin() {
    let ecx = network().ecx_asset().expect("betanet names its ECX");
    assert_eq!((ecx.id.as_str(), ecx.ticker.as_str(), ecx.decimals), ("", "ECX", 8));
}

#[test]
fn an_ecx_with_an_asset_id_is_refused() {
    let mut entry: ChainEntry = serde_json::from_str(CHAIN_ENTRY_JSON).unwrap();
    entry.networks.get_mut("betanet").unwrap().assets[0].id = "00".repeat(32);
    assert!(check_chain_entry(&entry).unwrap_err().contains("native coin"));
}
