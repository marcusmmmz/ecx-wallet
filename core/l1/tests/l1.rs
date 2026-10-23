//! Address fixtures are BIP84's own test vectors (github.com/bitcoin/bips bip-0084.mediawiki), for
//! "abandon … about": eCash betanet encodes them as Bitcoin does (`bc`).
mod common;

use common::{account_key, FINGERPRINT};
use ecx_l1::{chain_entry, declare, derive_account, network, OpDrivechain, ServerApi};

#[test]
fn derives_bip84s_receive_and_change_addresses() {
    let account = derive_account(&account_key(), 2, 1).unwrap();
    let receive: Vec<_> = account.receive.iter().map(|a| a.address.as_str()).collect();
    assert_eq!(receive, ["bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu", "bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g"]);
    assert_eq!(account.change[0].address, "bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el");
    assert_eq!(account.receive[0].script_pubkey, "0014c0cebcd6c3d3ca8c75dc5ec62ebe55330ef910e2");
    assert_eq!(account.receive[1].index, 1);
}

#[test]
fn each_address_carries_its_compressed_public_key() {
    // BIP84's vector for m/84'/0'/0'/0/0.
    let account = derive_account(&account_key(), 1, 0).unwrap();
    assert_eq!(account.receive[0].public_key, "0330d54fd0dd420a6e5f8d3624f5f3482cae350f79d5f0753bf5beef9c2d91af3c");
}

#[test]
fn the_descriptor_carries_the_fingerprint_and_account_path() {
    let account = derive_account(&account_key(), 0, 0).unwrap();
    assert!(account.descriptor.starts_with(&format!("wpkh([{FINGERPRINT}/84h/0h/0h]xpub")), "{}", account.descriptor);
    assert!(account.descriptor.ends_with("/<0;1>/*)"));
    assert!(!account.descriptor.contains("xprv"), "watch data is public");
}

#[test]
fn refuses_anything_but_an_l1_account_key() {
    let key = account_key();
    let bare = key.split_once(']').unwrap().1;
    let starter = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    for bad in [starter, bare, &key.replace("/84h/0h/0h]", "/44h/0h/0h]"), &key.replace("/84h/0h/0h]", "/84h/0h/1h]"), ""] {
        let error = derive_account(bad, 1, 0).unwrap_err();
        assert!(error.contains("invalid L1 Account Key"), "{bad}: {error}");
    }
}

#[test]
fn declare_reports_the_ecash_betanet_binding() {
    let d = declare();
    assert_eq!(d.binding.chain, "ecash:betanet");
    assert_eq!(d.binding.format, "psbt");
    assert_eq!(d.binding.payload_versions, ["0"]);
    assert_eq!(d.capabilities, ["buildDeposit"]);
}

#[test]
fn ecash_is_the_root_identified_by_its_fork_block() {
    assert_eq!(chain_entry().slot, None);
    let betanet = network();
    assert_eq!(betanet.parent, None);
    assert_eq!(betanet.identity_block.height, 967_680);
    assert_eq!(betanet.identity_block.hash, "00000000000000030101ba5cfea54b22becc79f95dc6040beb76e01dd9d04042");
    assert_eq!(betanet.sidechain_server.api, ServerApi::Esplora);
    assert_eq!(betanet.sidechain_server.url, "https://esplora.beta.ecash.ninja");
    let p = &betanet.params.address_params;
    assert_eq!((p.p2pkh_prefix, p.p2sh_prefix, p.bech_hrp.as_str()), (0, 5, "bc"));
}

#[test]
fn ecash_is_the_main_chain_and_its_native_coin_is_its_ecx() {
    assert_eq!(chain_entry().name, "Main chain");
    let ecx = network().ecx_asset().expect("betanet names its ECX");
    assert_eq!((ecx.id.as_str(), ecx.ticker.as_str(), ecx.name.as_str(), ecx.decimals), ("", "ECX", "eCash", 8));
}

#[test]
fn betanet_marks_spends_with_its_replay_locktime_and_reads_nop8_as_op_drivechain() {
    assert_eq!(network().params.replay_lock_time, 499_999_999);
    assert_eq!(network().params.op_drivechain, OpDrivechain::Nop8);
    assert_eq!(ecx_l1::treasury_script(24).unwrap(), "b7011851");
    assert!(ecx_l1::treasury_script(256).is_err());
}
