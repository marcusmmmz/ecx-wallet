//! flush.markets' `flush:` links (docs/adr/0016), read as strictly as Flush's own app reads them
//! (backbone-flush `src/webui/links.cpp` at 46310ac): `flush:<verb>?v=1&network=<net>&exp=<time>&…`,
//! each parameter once and no other, values of unreserved characters and `%XX` only. A link is an
//! Action, not a transaction: the wallet builds it. Only the trades (`swap`, `buy`, `sell`) are
//! read whole; every other action of Flush is unsupported.
use serde::Serialize;

use crate::psbt::{refuse, Refusal, RefusalCode};

/// A link longer than this is refused (`MAX_URI`).
pub const MAX_LINK_BYTES: usize = 4096;
/// The clock difference forgiven on `exp`, in seconds (`CLOCK_SKEW`).
pub const CLOCK_SKEW: i64 = 120;
/// How far ahead `exp` may be, in seconds (`MAX_LIFETIME`).
pub const MAX_LIFETIME: i64 = 24 * 60 * 60;
/// The most a link's `slippage_bps` may be (`MAX_SLIPPAGE_BPS`). It is shown only: the floor binds.
pub const MAX_SLIPPAGE_BPS: u16 = 5000;

/// The link's name of the network this build serves ([`crate::NETWORK`], betanet).
const LINK_NETWORK: &str = "ecashbeta";
const NETWORKS: [&str; 4] = ["ecash", "ecashbeta", "ecashtest", "regtest"];
const COIN: &str = "ECX";

/// Flush's app knows these actions; this wallet builds none of them yet.
const UNSUPPORTED: [&str; 18] = [
    "connect", "launch", "register", "curve", "pool", "auction", "order", "route", "deposit", "withdraw", "position", "reposition",
    "settle", "bid", "collect", "claim", "pegin", "pegout",
];

/// A trade a link asks for. Amounts are the link's decimals (at most 8 places), in the asset's
/// whole units; `expires` is a Unix time. Ids are 64 lowercase hex digits, as displayed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "verb", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Action {
    /// `amount` of `from` into the pool `pool`, at least `min_out` of `to` out. `from` and `to`
    /// are tickers, `ECX` for the coin.
    Swap { expires: i64, pool: String, from: String, to: String, amount: String, min_out: String, slippage_bps: Option<u16> },
    /// `ecx` into the launch curve of `asset` (named `launch`), at least `min_tokens` out.
    Buy { expires: i64, launch: String, asset: String, ecx: String, min_tokens: String, slippage_bps: Option<u16> },
    /// `tokens` of `asset` (named `launch`) into its launch curve, at least `min_ecx` out.
    Sell { expires: i64, launch: String, asset: String, tokens: String, min_ecx: String, slippage_bps: Option<u16> },
}

fn invalid(message: impl Into<String>) -> Refusal {
    refuse(RefusalCode::InvalidAction, message)
}

/// Reads `uri`, a `flush:` action link, at the Unix time `now`.
pub fn parse_action(uri: &str, now: i64) -> Result<Action, Refusal> {
    if uri.len() > MAX_LINK_BYTES {
        return Err(invalid(format!("The link is too long ({} bytes; at most {MAX_LINK_BYTES})", uri.len())));
    }
    let rest = match uri.split_once(':') {
        Some((scheme, rest)) if scheme.eq_ignore_ascii_case("flush") => rest,
        _ => return Err(invalid("Not an action link of Flush (flush:<verb>?v=1&...)")),
    };
    let (verb, query) = match rest.split_once('?') {
        Some((verb, query)) if !verb.is_empty() && verb.bytes().all(|b| b.is_ascii_lowercase()) => (verb, query),
        _ => return Err(invalid("Not an action link of Flush (flush:<verb>?v=1&...)")),
    };
    let trade = matches!(verb, "swap" | "buy" | "sell");
    if !trade && !UNSUPPORTED.contains(&verb) {
        return Err(invalid(format!("\"{}\" is not an action of Flush", truncate(verb, 20))));
    }

    let mut params = Params::parse(query)?;
    match params.take("v") {
        None => return Err(invalid("v is missing: links of version 1 only")),
        Some(v) if v != "1" => return Err(invalid(format!("This link is of version {}: version 1 only", truncate(&v, 8)))),
        Some(_) => {}
    }
    let network = params.need("network")?;
    if !NETWORKS.contains(&network.as_str()) {
        return Err(invalid(format!("network: \"{}\" is not a network of Flush", truncate(&network, 20))));
    }
    if network != LINK_NETWORK {
        return Err(invalid(format!("This link is for the network {network}, and this wallet runs {LINK_NETWORK}")));
    }
    let exp = params.need("exp")?;
    if exp.len() > 12 || !exp.bytes().all(|b| b.is_ascii_digit()) || exp.starts_with('0') {
        return Err(invalid("exp: the Unix time the link expires"));
    }
    let expires: i64 = exp.parse().map_err(|_| invalid("exp: the Unix time the link expires"))?;
    if now > expires + CLOCK_SKEW {
        return Err(invalid("This link has expired: ask the site for a fresh one"));
    }
    if expires > now + MAX_LIFETIME + CLOCK_SKEW {
        return Err(invalid("This link would be good for more than a day: refused (check the computer's clock)"));
    }
    if !trade {
        return Err(refuse(RefusalCode::UnsupportedAction, format!("This wallet doesn't do Flush's \"{verb}\" yet")));
    }

    let action = match verb {
        "swap" => {
            let pool = id(params.need("pool")?, "pool")?;
            let from = ticker(params.need("from")?, "from", true)?;
            let to = ticker(params.need("to")?, "to", true)?;
            if from == to {
                return Err(invalid("from and to are the same"));
            }
            let amount = amount(params.need("amount")?, "amount")?;
            let min_out = amount_of(params.need("min_out")?, "min_out")?;
            Action::Swap { expires, pool, from, to, amount, min_out, slippage_bps: params.slippage()? }
        }
        "buy" => {
            let launch = ticker(params.need("launch")?, "launch", false)?;
            let asset = id(params.need("asset")?, "asset")?;
            let ecx = amount(params.need("ecx")?, "ecx")?;
            let min_tokens = amount_of(params.need("min_tokens")?, "min_tokens")?;
            Action::Buy { expires, launch, asset, ecx, min_tokens, slippage_bps: params.slippage()? }
        }
        _ => {
            let launch = ticker(params.need("launch")?, "launch", false)?;
            let asset = id(params.need("asset")?, "asset")?;
            let tokens = amount(params.need("tokens")?, "tokens")?;
            let min_ecx = amount_of(params.need("min_ecx")?, "min_ecx")?;
            Action::Sell { expires, launch, asset, tokens, min_ecx, slippage_bps: params.slippage()? }
        }
    };
    if let Some(key) = params.0.first().map(|(key, _)| key) {
        return Err(invalid(format!("{key} is not a parameter of {verb}: refused (a link of a later version needs a newer wallet)")));
    }
    Ok(action)
}

/// A link's parameters, percent-decoded, each once.
struct Params(Vec<(String, String)>);

impl Params {
    fn parse(query: &str) -> Result<Self, Refusal> {
        let mut params: Vec<(String, String)> = Vec::new();
        let pairs: Vec<&str> = query.split('&').collect();
        for (i, pair) in pairs.iter().enumerate() {
            if pair.is_empty() {
                // One `&` at the end is taken, as the app takes it.
                if i == pairs.len() - 1 {
                    break;
                }
                return Err(invalid("An empty parameter (&&)"));
            }
            let (key, raw) = match pair.split_once('=') {
                Some((key, raw)) if !key.is_empty() => (key, raw),
                _ => return Err(invalid("A parameter without a name or a value")),
            };
            if key.len() > 32 || !key.bytes().all(|b| b.is_ascii_lowercase() || b == b'_') {
                return Err(invalid("A parameter's name is lowercase letters and _"));
            }
            let value = decode(raw, key)?;
            if params.iter().any(|(k, _)| k == key) {
                return Err(invalid(format!("{key} is given twice")));
            }
            params.push((key.to_string(), value));
        }
        Ok(Params(params))
    }

    fn take(&mut self, key: &str) -> Option<String> {
        let i = self.0.iter().position(|(k, _)| k == key)?;
        Some(self.0.remove(i).1)
    }

    fn need(&mut self, key: &str) -> Result<String, Refusal> {
        match self.take(key) {
            None => Err(invalid(format!("{key} is missing"))),
            Some(v) if v.is_empty() => Err(invalid(format!("{key} is empty"))),
            Some(v) => Ok(v),
        }
    }

    fn slippage(&mut self) -> Result<Option<u16>, Refusal> {
        let Some(text) = self.take("slippage_bps") else { return Ok(None) };
        let bps = whole_number(&text).filter(|bps| *bps <= u64::from(MAX_SLIPPAGE_BPS));
        bps.map(|bps| Some(bps as u16)).ok_or_else(|| invalid(format!("slippage_bps: whole basis points, 0 to {MAX_SLIPPAGE_BPS}")))
    }
}

/// A value of the query, percent-decoded: only unreserved characters and `%XX` (a space is `%20`, never `+`).
fn decode(raw: &str, key: &str) -> Result<String, Refusal> {
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        if b == b'%' {
            let hex = |c: Option<&u8>| c.and_then(|c| (*c as char).to_digit(16));
            match (hex(bytes.get(i + 1)), hex(bytes.get(i + 2))) {
                (Some(hi), Some(lo)) => out.push((hi * 16 + lo) as u8),
                _ => return Err(invalid(format!("{key}: a % without two hex digits"))),
            }
            i += 3;
        } else if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~') {
            out.push(b);
            i += 1;
        } else {
            return Err(invalid(format!("{key}: a character that must be percent-encoded")));
        }
    }
    // Every value a trade takes is ASCII, so text that isn't UTF-8 fails its own check anyway.
    String::from_utf8(out).map_err(|_| invalid(format!("{key} is not valid UTF-8")))
}

/// 0, or digits without a leading zero.
fn whole_number(text: &str) -> Option<u64> {
    let digits = !text.is_empty() && text.bytes().all(|b| b.is_ascii_digit()) && !(text.len() > 1 && text.starts_with('0'));
    if digits { text.parse().ok() } else { None }
}

/// A decimal of at most 15 whole digits and 8 places, without sign or exponent; 0 allowed.
fn amount_of(text: String, key: &str) -> Result<String, Refusal> {
    let (whole, places) = match text.split_once('.') {
        Some((whole, places)) => (whole, Some(places)),
        None => (text.as_str(), None),
    };
    let whole_ok = !whole.is_empty() && whole.len() <= 15 && whole.bytes().all(|b| b.is_ascii_digit()) && !(whole.len() > 1 && whole.starts_with('0'));
    let places_ok = places.is_none_or(|p| !p.is_empty() && p.len() <= 8 && p.bytes().all(|b| b.is_ascii_digit()));
    if !whole_ok || !places_ok {
        return Err(invalid(format!("{key}: an amount is a decimal of at most 8 places, without sign or exponent (\"{}\")", truncate(&text, 40))));
    }
    Ok(text)
}

/// An amount paid: as [`amount_of`], and more than 0.
fn amount(text: String, key: &str) -> Result<String, Refusal> {
    let text = amount_of(text, key)?;
    if text.bytes().all(|b| b == b'0' || b == b'.') {
        return Err(invalid(format!("{key}: the amount is 0")));
    }
    Ok(text)
}

/// An id: exactly 64 lowercase hex digits.
fn id(text: String, key: &str) -> Result<String, Refusal> {
    if text.len() != 64 || !text.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
        return Err(invalid(format!("{key}: an id is exactly 64 lowercase hex digits")));
    }
    Ok(text)
}

/// A ticker: 2 to 12 capital letters and digits; `ECX` only where the coin may stand (`coin`).
fn ticker(text: String, key: &str, coin: bool) -> Result<String, Refusal> {
    if coin && text == COIN {
        return Ok(text);
    }
    let shape = (2..=12).contains(&text.len()) && text.bytes().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit());
    if !shape || text == COIN {
        return Err(invalid(format!("{key}: a ticker is 2 to 12 capital letters and digits (\"{}\")", truncate(&text, 20))));
    }
    Ok(text)
}

fn truncate(text: &str, chars: usize) -> String {
    text.chars().take(chars).collect()
}
