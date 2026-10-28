//! flush.markets' `flush:` links, read as Flush's own app reads them (backbone-flush
//! `src/webui/links.cpp` on `flush-betanet`, `9cc49a8`): the trades parse, every other action is unsupported, and
//! anything the app would refuse is refused (docs/adr/0016).
use ecx_flush::{parse_action, Action, RefusalCode};

const NOW: i64 = 1_800_000_000;
const POOL: &str = "2b16f8c06c0f98034bacfe23cec9e36ce96b3d1282766dd957901435354b402a";
const FORK: &str = "6bb2ae6e23e626cd2fba1f8845d8bbc047aeb9a8f4690ee9a21b5d04584dfb03";

fn swap(extra: &str) -> String {
    format!("flush:swap?v=1&network=ecashbeta&exp={}&pool={POOL}&from=ECX&to=FORK&amount=0.0001&min_out=0.044{extra}", NOW + 600)
}

fn refused(uri: &str) -> RefusalCode {
    parse_action(uri, NOW).expect_err(uri).code
}

#[test]
fn a_swap_names_its_pool_sides_amount_and_floor() {
    let action = parse_action(&swap("&slippage_bps=50"), NOW).unwrap();
    assert_eq!(
        action,
        Action::Swap {
            expires: NOW + 600,
            pool: POOL.into(),
            from: "ECX".into(),
            to: "FORK".into(),
            amount: "0.0001".into(),
            min_out: "0.044".into(),
            slippage_bps: Some(50),
        }
    );
    assert!(matches!(parse_action(&swap(""), NOW).unwrap(), Action::Swap { slippage_bps: None, .. }));
}

#[test]
fn a_buy_pays_ecx_and_a_sale_pays_tokens() {
    let buy = format!("flush:buy?v=1&network=ecashbeta&exp={}&launch=FORK&asset={FORK}&ecx=0.0001&min_tokens=0.04", NOW + 60);
    assert_eq!(
        parse_action(&buy, NOW).unwrap(),
        Action::Buy { expires: NOW + 60, launch: "FORK".into(), asset: FORK.into(), ecx: "0.0001".into(), min_tokens: "0.04".into(), slippage_bps: None }
    );
    let sell = format!("flush:sell?v=1&network=ecashbeta&exp={}&launch=FORK&asset={FORK}&tokens=12.5&min_ecx=0.00002", NOW + 60);
    assert_eq!(
        parse_action(&sell, NOW).unwrap(),
        Action::Sell { expires: NOW + 60, launch: "FORK".into(), asset: FORK.into(), tokens: "12.5".into(), min_ecx: "0.00002".into(), slippage_bps: None }
    );
}

#[test]
fn the_scheme_in_any_case_percent_escapes_and_a_trailing_ampersand_are_taken() {
    assert!(parse_action(&swap("&").replacen("flush:", "FLUSH:", 1), NOW).is_ok());
    assert!(parse_action(&swap("").replace("amount=0.0001", "amount=0%2E0001"), NOW).is_ok());
}

#[test]
fn expiry_forgives_two_minutes_and_allows_a_day() {
    let at = |exp: i64| swap("").replace(&format!("exp={}", NOW + 600), &format!("exp={exp}"));
    assert!(parse_action(&at(NOW - 120), NOW).is_ok());
    assert_eq!(refused(&at(NOW - 121)), RefusalCode::InvalidAction);
    assert!(parse_action(&at(NOW + 86_400 + 120), NOW).is_ok());
    assert_eq!(refused(&at(NOW + 86_400 + 121)), RefusalCode::InvalidAction);
    assert_eq!(refused(&at(0).replace("exp=0", "exp=0123")), RefusalCode::InvalidAction);
}

#[test]
fn what_flushs_app_refuses_is_refused() {
    let cases = [
        swap("").replace("v=1", "v=2"),
        swap("").replace("v=1&", ""),
        swap("").replace("network=ecashbeta", "network=ecash"),
        swap("").replace("network=ecashbeta", "network=elsewhere"),
        swap("&memo=hi"),
        swap("&amount=1"),
        swap("&&slippage_bps=50"),
        swap("&slippage_bps=5001"),
        swap("&slippage_bps=050"),
        swap("").replace("to=FORK", "to=ECX"),
        swap("").replace("to=FORK", "to=fork"),
        swap("").replace("amount=0.0001", "amount=0.000"),
        swap("").replace("amount=0.0001", "amount=0.000000001"),
        swap("").replace("amount=0.0001", "amount=01"),
        swap("").replace("amount=0.0001", "amount=1e3"),
        swap("").replace("amount=0.0001", "amount=%2B1"),
        swap("").replace("min_out=0.044", "min_out=0.044+"),
        swap("").replace(POOL, &POOL.to_uppercase()),
        swap("").replace("&min_out=0.044", ""),
        swap("").replace("from=ECX", "from="),
        format!("flush:buy?v=1&network=ecashbeta&exp={}&launch=ECX&asset={FORK}&ecx=0.0001&min_tokens=0.04", NOW + 60),
        format!("flush:teleport?v=1&network=ecashbeta&exp={}", NOW + 60),
        "flush:bflx1qexample?amount=1".to_string(),
        "bitcoin:swap?v=1".to_string(),
        swap(&format!("&slippage_bps=1{}", "0".repeat(4096))),
    ];
    for uri in cases {
        assert_eq!(refused(&uri), RefusalCode::InvalidAction, "{uri}");
    }
}

#[test]
fn other_actions_are_unsupported_not_invalid() {
    for verb in ["connect", "route", "deposit", "withdraw", "order", "launch", "pegout"] {
        let uri = format!("flush:{verb}?v=1&network=ecashbeta&exp={}", NOW + 60);
        assert_eq!(refused(&uri), RefusalCode::UnsupportedAction, "{verb}");
    }
    // The version and the network are checked first, as the app does.
    assert_eq!(refused(&format!("flush:route?v=2&network=ecashbeta&exp={}", NOW + 60)), RefusalCode::InvalidAction);
}
