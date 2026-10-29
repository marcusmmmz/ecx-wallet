//! A trade's result output, spent (docs/adr/0013): its marker lists it with no token, since only the
//! node's state knows what it carries. The market index names it; this checks that name against the
//! order its own transaction states, so the wallet can spend it and the Decoder show it Clear.
//!
//! - A fill pays the asset at the end of the order's pools, at least its floor (`min_out`); the
//!   pools' descriptions (`getpool`) prove which asset that is, each id recomputed.
//! - A miss refunds exactly what went in (`asset_in`, `amount_in`).
//!
//! What's left is the amount of a fill, which only the index says. A wrong one can't cost anything:
//! a transfer must carry on exactly the tokens its inputs bring, or the node refuses it
//! (`bad-ba-tokens-lost`, `bad-ba-tokens-unbacked`).
use bitcoin::Transaction;
use serde::Deserialize;

use crate::bast::{self, Token, TokenKind};
use crate::psbt::Refusal;
use crate::tokens;
use crate::trade::{pool_kind, PoolReport};

/// What the market index says a result output carries, with the order's pools as `getpool`
/// describes each, in its order.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResultClaim {
    /// Display hex.
    pub asset: String,
    /// Base units, decimal.
    pub amount: String,
    pub pools: Vec<PoolReport>,
}

/// A result a transaction spends, as a request's evidence names it (`results`): its outpoint and
/// what the market index says it carries.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResultEvidence {
    /// Display hex.
    pub txid: String,
    pub vout: u32,
    pub asset: String,
    pub amount: String,
    pub pools: Vec<PoolReport>,
}

impl ResultEvidence {
    pub(crate) fn claim(&self) -> ResultClaim {
        ResultClaim { asset: self.asset.clone(), amount: self.amount.clone(), pools: self.pools.clone() }
    }
}

/// The token output `vout` of `tx` carries, if it is a trade's result and `claim` fits its order;
/// else why not.
pub(crate) fn result_token(tx: &Transaction, vout: u32, claim: &ResultClaim) -> Result<Result<Token, String>, Refusal> {
    let Some((_, marker)) = tokens::marker(tx)? else { return Ok(Err("its transaction has no BAST marker".into())) };
    if marker.kind != 21 || !marker.outputs.iter().any(|o| o.n == vout && o.token.is_none()) {
        return Ok(Err(format!("output {vout} isn't a trade's result")));
    }
    let f = &marker.fields;
    let text = |key: &str| f.get(key).and_then(|v| v.as_str()).unwrap_or_default().to_ascii_lowercase();
    let number = |key: &str| f.get(key).and_then(|v| v.as_u64());
    let pools: Vec<&str> = f.get("pools").and_then(|v| v.as_array()).map(|a| a.iter().filter_map(|p| p.as_str()).collect()).unwrap_or_default();
    let (Some(amount_in), Some(min_out)) = (number("amount_in"), number("min_out")) else {
        return Ok(Err("its order states no amount in or floor".into()));
    };
    if pools.is_empty() || pools.len() != claim.pools.len() {
        return Ok(Err(format!("its order goes through {} pools, and {} are described", pools.len(), claim.pools.len())));
    }
    // From what it paid in, through each pool to its other side: where a fill ends.
    let asset_in = text("asset_in");
    let mut at = asset_in.clone();
    for (pool, &named) in claim.pools.iter().zip(&pools) {
        let (a, b) = (pool.asset_a_id.to_ascii_lowercase(), pool.asset_b_id.to_ascii_lowercase());
        let id = match pool_kind(pool).map(|kind| bast::pool_id(&a, &b, &kind)) {
            Ok(Ok(id)) => id,
            Ok(Err(e)) => return Ok(Err(format!("pool {named}'s description: {e}"))),
            Err(e) => return Ok(Err(format!("pool {named}'s description: {}", e.message))),
        };
        if id != named {
            return Ok(Err(format!("the pool described is {id}, not the {named} its order names")));
        }
        at = if a == at { b } else if b == at { a } else { return Ok(Err(format!("pool {named} doesn't hold asset {at}, which comes to it"))) };
    }
    let asset = claim.asset.to_ascii_lowercase();
    let Ok(amount) = claim.amount.parse::<u64>() else { return Ok(Err(format!("{} isn't an amount", claim.amount))) };
    if asset.bytes().all(|c| c == b'0') {
        return Ok(Err("a result output carries a token, never ECX".into()));
    }
    let fill = asset == at && amount >= min_out;
    let refund = asset == asset_in && amount == amount_in;
    if !fill && !refund {
        return Ok(Err(format!("{amount} of asset {asset} is neither its fill (at least {min_out} of {at}) nor its refund ({amount_in} of {asset_in})")));
    }
    Ok(Ok(Token { kind: TokenKind::Asset, id: asset, amount }))
}
