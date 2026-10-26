//! What a Deposit to Slot 46 is credited to (`deposit_destination`, #57).
mod common;

use common::STARTER;
use ecx_flush::{declare, deposit_destination, long_form, MAX_DESTINATION_BYTES};

#[test]
fn the_long_form_is_flushs_with_its_checksum() {
    // A live Slot 99 Deposit's destination (eCash betanet, M5 f6361619…2180, 2026-10-25).
    assert_eq!(long_form(99, "bflx1qxwjcrk85t3ue30wah6y7setkphxh9dgl9e94hz"), "s99_bflx1qxwjcrk85t3ue30wah6y7setkphxh9dgl9e94hz_71491f");
    // P2WPKH on Slot 46: 55 bytes, within Backbone's 100.
    assert_eq!(long_form(46, "bflx1qxwjcrk85t3ue30wah6y7setkphxh9dgl9e94hz").len(), 55);
    assert!(55 <= MAX_DESTINATION_BYTES);
}

#[test]
fn no_deposit_until_the_activation_is_pinned() {
    // Slot 46 isn't active on betanet: its Chain Entry pins no activation (docs/adr/0004).
    assert!(!declare().capabilities.contains(&"depositDestination".to_string()));
    assert!(deposit_destination(STARTER).unwrap_err().contains("pins no activation block"));
}
