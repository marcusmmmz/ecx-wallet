//! `build_trade(order, starter)`: a trade a `flush:` link asks for (`swap`, `buy`, `sell`), built
//! from the account's coins as Flush's own wallet builds it (docs/adr/0016; backbone-flush
//! `src/wallet/rpc/bitassets.cpp` at 46310ac): one `swap_pools` marker (kind 21) through the pool.
//!
//! - Outputs: the change of a token paid in (if any), then one result output, both to the
//!   given-out address the site knows; then the marker, carrying the ECX paid in; then ECX change.
//!   `chn_to`, where ECX comes out or back, is the given-out address too, when ECX is on a side.
//! - The pool is proven, not reported: its id is recomputed from the kind `getpool` reports, and
//!   must be the link's (a swap) or the launch's curve of ECX and the token (a buy or a sale). Its
//!   two assets must be the link's, each ticker the hash of its id. A buy's or sale's link names no
//!   pool: a wrong fee reported there names a pool that doesn't exist, which the node refuses.
//! - A token's decimals come from its registration transaction, checked as `asset_registration`
//!   checks a name; amounts paid fit them exactly, and the floor is rounded up to them.
//! - The floor must be one the node's quote meets now, and not more than 10% below it.
//!
//! The quote and the least ECX the node pays out are the explorer's word: a lie there makes a trade
//! fail or refunds it, never pays less than the floor, which the node enforces.
use std::collections::BTreeSet;

use bitcoin::{Amount, ScriptBuf, TxOut};
use serde::{Deserialize, Serialize};

use crate::bast::{self, PoolKind};
use crate::link::{parse_action, Action};
use crate::psbt::{refuse, Refusal, RefusalCode};
use crate::tokens::asset_registration;
use crate::transfer::{complete, read_coins, select_tokens, Coin, Draft, Spent};
use crate::AccountKeys;

/// How far below the node's quote a floor may be, in percent (docs/adr/0016).
pub const MAX_FLOOR_SHORTFALL_PERCENT: u64 = 10;

/// The id the node gives ECX in a marker and a pool.
const ECX_ID: &str = "0000000000000000000000000000000000000000000000000000000000000000";
const ECX_DECIMALS: u8 = 8;
const LAUNCH_CURVE: u8 = 3;

/// What to trade, and what to build it from.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TradeOrder {
    /// The `flush:` link, as the app gave it.
    pub link: String,
    /// The Unix time, for the link's `exp`.
    pub now: i64,
    /// The pool, as the explorer's `getpool` answers.
    pub pool: PoolReport,
    /// The current registration transaction (hex) of each token the trade involves.
    pub registrations: Vec<String>,
    /// What the node's `getswapquote` says this pool gives now for the amount in, in whole units.
    pub quote: f64,
    /// `getbitassetsinfo`'s `min_chn_payout`, in ECX.
    pub min_payout: f64,
    /// The account's coins to choose from (the wallet's rule: confirmed or trusted, none held back).
    pub coins: Vec<Coin>,
    /// Sats per 1000 vbytes.
    pub fee_rate: u64,
    /// The change address's index (the account's first unused one).
    pub change_index: u32,
}

/// The fields of `getpool`'s answer the trade reads (the rest are ignored).
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct PoolReport {
    pub asset_a_id: String,
    pub asset_b_id: String,
    pub curve: String,
    pub fee_millionths: u32,
    #[serde(default)]
    pub amp: u32,
    #[serde(default)]
    pub weight_a: u8,
    #[serde(default)]
    pub weight_b: u8,
    #[serde(default)]
    pub dynamic_fee: bool,
    #[serde(default)]
    pub abandoned: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TradeBuilt {
    /// Base64: a PSBT, as `build_transfer`'s.
    pub pset: String,
    /// The coins it spends, to hold back until it confirms.
    pub spent: Vec<Spent>,
    /// Sats of ECX the marker locks: what broadcasting must allow (`maxburnamount`).
    pub burn: String,
    /// What the Clear View shows beside the transaction: the trade as checked.
    pub trade: CheckedTrade,
}

/// A trade, in base units, as the module checked it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckedTrade {
    /// `swap`, `buy` or `sell`.
    pub verb: &'static str,
    pub pool: String,
    pub asset_in: Side,
    pub asset_out: Side,
    pub amount_in: String,
    pub min_out: String,
    /// The node's quote, in base units of what comes out.
    pub quote: String,
    /// The link's `exp`, a Unix time.
    pub expires: i64,
}

/// An asset of a trade: its id ("" for ECX), ticker and decimals.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Side {
    pub id: String,
    pub ticker: String,
    pub decimals: u8,
}

fn invalid(message: impl Into<String>) -> Refusal {
    refuse(RefusalCode::InvalidAction, message)
}

fn starter_refusal(message: String) -> Refusal {
    refuse(RefusalCode::InvalidStarter, message)
}

pub fn build_trade(order_json: &str, starter: &str) -> Result<TradeBuilt, Refusal> {
    let order: TradeOrder = serde_json::from_str(order_json).map_err(|e| refuse(RefusalCode::Malformed, format!("Invalid trade order: {e}")))?;
    let keys = AccountKeys::new(starter).map_err(starter_refusal)?;
    let action = parse_action(&order.link, order.now)?;

    let kind = pool_kind(&order.pool)?;
    let (a, b) = (order.pool.asset_a_id.to_ascii_lowercase(), order.pool.asset_b_id.to_ascii_lowercase());
    let pool = bast::pool_id(&a, &b, &kind).map_err(|e| invalid(format!("The pool's assets: {e}")))?;
    if order.pool.abandoned {
        return Err(invalid("Nobody provides liquidity to this pool any more: a trade would get almost nothing."));
    }
    let pair = BTreeSet::from([a, b]);
    let registered = |id: &str| -> Result<Side, Refusal> {
        if id == ECX_ID {
            return Ok(Side { id: String::new(), ticker: "ECX".into(), decimals: ECX_DECIMALS });
        }
        let checked = order
            .registrations
            .iter()
            .find_map(|hex| asset_registration(id, hex).ok())
            .ok_or_else(|| invalid(format!("The wallet couldn't check asset {id}'s registration, so it can't tell its decimals.")))?;
        Ok(Side { id: id.into(), ticker: checked.ticker, decimals: checked.decimals })
    };
    // Each side by its ticker: ECX's id is null, a token's is its ticker's hash.
    let id_of = |ticker: &str| if ticker == "ECX" { ECX_ID.to_string() } else { bast::asset_id(ticker) };

    let (verb, expires, asset_in, asset_out, amount_in, floor) = match &action {
        Action::Swap { expires, pool: named, from, to, amount, min_out, .. } => {
            if *named != pool {
                return Err(invalid(format!("The pool the explorer describes is {pool}, not the link's {named}.")));
            }
            ("swap", *expires, id_of(from), id_of(to), amount, min_out)
        }
        Action::Buy { expires, launch, asset, ecx, min_tokens, .. } | Action::Sell { expires, launch, asset, tokens: ecx, min_ecx: min_tokens, .. } => {
            if bast::asset_id(launch) != *asset {
                return Err(invalid(format!("The link names launch {launch}, which isn't asset {asset}.")));
            }
            if kind.curve != LAUNCH_CURVE {
                return Err(invalid("The pool isn't a launch's curve: the asset trades in a pool now (a swap)."));
            }
            let buy = matches!(action, Action::Buy { .. });
            let (asset_in, asset_out) = if buy { (ECX_ID.to_string(), asset.clone()) } else { (asset.clone(), ECX_ID.to_string()) };
            (if buy { "buy" } else { "sell" }, *expires, asset_in, asset_out, ecx, min_tokens)
        }
    };
    if pair != BTreeSet::from([asset_in.clone(), asset_out.clone()]) {
        return Err(invalid("The pool doesn't trade the link's two assets."));
    }
    let (side_in, side_out) = (registered(&asset_in)?, registered(&asset_out)?);
    let amount_in = units(amount_in, side_in.decimals, false).ok_or_else(|| invalid(format!("{amount_in} {} has more places than its {}.", side_in.ticker, side_in.decimals)))?;
    let min_out = units(floor, side_out.decimals, true).ok_or_else(|| invalid(format!("The floor {floor} {} is too large.", side_out.ticker)))?;
    let quote = whole_to_units(order.quote, side_out.decimals).ok_or_else(|| invalid("The node's quote isn't an amount."))?;
    if quote < min_out {
        return Err(invalid("The pool gives less than the link's floor now: ask the site for a fresh quote."));
    }
    if (min_out as u128) * 100 < (quote as u128) * (100 - MAX_FLOOR_SHORTFALL_PERCENT as u128) {
        return Err(invalid(format!("The link's floor is more than {MAX_FLOOR_SHORTFALL_PERCENT}% below what the pool gives now: refused, as a site could set it to take the difference.")));
    }
    let min_payout = whole_to_units(order.min_payout, ECX_DECIMALS).ok_or_else(|| invalid("The least payout isn't an amount."))?;
    if side_in.id.is_empty() && amount_in < min_payout {
        return Err(invalid(format!("A trade pays in at least {} ECX.", order.min_payout)));
    }
    if side_out.id.is_empty() && min_out < min_payout {
        return Err(invalid(format!("Flush pays out at least {} ECX: the floor is below it.", order.min_payout)));
    }

    // The outputs before the marker: what's left of the token paid in, then the result.
    let given_out = keys.script(0, 0).map_err(starter_refusal)?;
    let wanted: BTreeSet<String> = [side_in.id.clone()].into_iter().filter(|id| !id.is_empty()).collect();
    let (coins, mut token_coins) = read_coins(&order.coins, &keys, &wanted)?;
    let mut fixed = vec![];
    let mut listed: Vec<(u32, Option<(&str, u64)>)> = vec![];
    let mut token_inputs = vec![];
    if !side_in.id.is_empty() {
        let (chosen, total) = select_tokens(token_coins.remove(&side_in.id).unwrap_or_default(), &side_in.id, amount_in, "pays in")?;
        token_inputs = chosen;
        if total > amount_in {
            listed.push((0, Some((side_in.id.as_str(), total - amount_in))));
            fixed.push(TxOut { value: Amount::ZERO, script_pubkey: given_out.clone() });
        }
    }
    listed.push((fixed.len() as u32, None));
    fixed.push(TxOut { value: Amount::ZERO, script_pubkey: given_out.clone() });
    let own: Vec<(usize, u32, u32)> = (0..fixed.len()).map(|n| (n, 0, 0)).collect();
    let chn_to = if side_in.id.is_empty() || side_out.id.is_empty() { given_out.to_bytes() } else { vec![] };
    let burn = if side_in.id.is_empty() { amount_in } else { 0 };
    let marker = bast::swap_pools_marker(&side_in.id_or_ecx(), &[pool.as_str()], amount_in, min_out, &chn_to, &listed)
        .map_err(|e| refuse(RefusalCode::Malformed, format!("Can't write the trade's marker: {e}.")))?;
    fixed.push(TxOut { value: Amount::from_sat(burn), script_pubkey: ScriptBuf::from_bytes(marker) });

    let built = complete(Draft { fixed, own, token_inputs, coins, need: burn, fee_rate: order.fee_rate.max(crate::transfer::MIN_FEE_RATE), change_index: order.change_index }, &keys)?;
    let trade = CheckedTrade {
        verb,
        pool,
        asset_in: side_in,
        asset_out: side_out,
        amount_in: amount_in.to_string(),
        min_out: min_out.to_string(),
        quote: quote.to_string(),
        expires,
    };
    Ok(TradeBuilt { pset: built.pset, spent: built.spent, burn: burn.to_string(), trade })
}

impl Side {
    /// Its id as a marker writes it: ECX's is null.
    fn id_or_ecx(&self) -> String {
        if self.id.is_empty() { ECX_ID.into() } else { self.id.clone() }
    }
}

/// The pool's kind, from `getpool`'s words for it.
fn pool_kind(pool: &PoolReport) -> Result<PoolKind, Refusal> {
    let curve = match pool.curve.as_str() {
        "constant_product" => 0,
        "stable" => 1,
        "weighted" => 2,
        "launch" => 3,
        "concentrated" => 4,
        "book" => 5,
        other => return Err(invalid(format!("A pool of an unknown kind ({other})."))),
    };
    // getpool gives each side's weight; the node keeps the one of the asset whose id is lower.
    let a_lower = internal_order(&pool.asset_a_id) <= internal_order(&pool.asset_b_id);
    let weight0 = if curve == 2 { if a_lower { pool.weight_a } else { pool.weight_b } } else { 0 };
    Ok(PoolKind { curve, fee: pool.fee_millionths, amp: if curve == 1 { pool.amp } else { 0 }, weight0, flags: u8::from(pool.dynamic_fee) })
}

/// An id's bytes as the node compares them (internal order: display hex reversed).
fn internal_order(id: &str) -> Vec<u8> {
    let mut bytes: Vec<u8> = (0..id.len()).step_by(2).filter_map(|i| id.get(i..i + 2).and_then(|h| u8::from_str_radix(h, 16).ok())).collect();
    bytes.reverse();
    bytes
}

/// A link's decimal (checked by `parse_action`) in base units of `decimals` places: exactly, or,
/// `round_up`, the next unit up. None if it has more places (and not `round_up`) or overflows.
fn units(decimal: &str, decimals: u8, round_up: bool) -> Option<u64> {
    let (whole, places) = decimal.split_once('.').unwrap_or((decimal, ""));
    let d = decimals as usize;
    let (kept, dropped) = if places.len() > d { places.split_at(d) } else { (places, "") };
    if !dropped.is_empty() && !round_up {
        return None;
    }
    let digits = format!("{whole}{kept:0<d$}");
    let value: u64 = digits.parse().ok()?;
    let up = dropped.bytes().any(|b| b != b'0');
    if up { value.checked_add(1) } else { Some(value) }.filter(|v| *v <= i64::MAX as u64)
}

/// A JSON number of whole units in base units of `decimals` places, to the nearest unit.
fn whole_to_units(amount: f64, decimals: u8) -> Option<u64> {
    let units = (amount * 10f64.powi(decimals as i32)).round();
    (amount.is_finite() && units >= 0.0 && units <= i64::MAX as f64).then_some(units as u64)
}
