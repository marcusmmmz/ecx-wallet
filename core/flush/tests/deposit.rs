//! What a Deposit to Flush's Slot is credited to (`deposit_destination`, #57).
mod common;

use common::STARTER;
use ecx_flush::{declare, deposit_destination, derive_account, long_form, MAX_DESTINATION_BYTES};

#[test]
fn the_long_form_is_flushs_with_its_checksum() {
    // A live Slot 99 Deposit's destination (eCash betanet, M5 f6361619…2180, 2026-10-25).
    assert_eq!(long_form(99, "bflx1qxwjcrk85t3ue30wah6y7setkphxh9dgl9e94hz"), "s99_bflx1qxwjcrk85t3ue30wah6y7setkphxh9dgl9e94hz_71491f");
    // P2WPKH on Slot 46 (mainnet's): 55 bytes, within Backbone's 100.
    assert_eq!(long_form(46, "bflx1qxwjcrk85t3ue30wah6y7setkphxh9dgl9e94hz").len(), 55);
    assert!(55 <= MAX_DESTINATION_BYTES);
}

#[test]
fn a_deposit_on_betanet_is_credited_to_the_first_receive_address_in_slot_99s_long_form() {
    // Slot 99's activation is pinned (docs/adr/0004, 0014), so the module offers Deposits.
    assert!(declare().capabilities.contains(&"depositDestination".to_string()));
    let receive = derive_account(STARTER, 1, 0).unwrap().receive.remove(0);
    let d = deposit_destination(STARTER).unwrap();
    assert_eq!(d.address, receive.address);
    assert_eq!(d.script_pubkey, receive.script_pubkey);
    assert_eq!(d.destination, long_form(99, &receive.address).bytes().map(|b| format!("{b:02x}")).collect::<String>());
    assert_eq!((d.asset.as_str(), d.minimum.as_str()), ("", "294"));
}
