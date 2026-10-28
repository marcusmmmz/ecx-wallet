//! The `BAST` marker: the one `OP_RETURN` output through which a Flush transaction moves tokens and
//! runs a token or DEX operation (backbone-flush `src/bitassets/state.{h,cpp}`, `doc/bitassets.md`).
//!
//! The marker names every output that carries a token ("listed outputs"), each with its token, or as
//! a "result" whose token only the node's state knows (swaps, pool withdrawals, …). A transaction
//! that spends a token output without a marker is invalid, not a burn (`bad-ba-tokens-lost`).
//!
//! [`parse`] decodes a marker as the node does, refusing anything the node would refuse to read.
//! The node re-encodes what it parsed and requires the same script byte for byte ("one way to write
//! a marker", `state.cpp` `ParseMarker`), so this refuses every non-canonical form too: a non-minimal
//! push, a non-canonical CompactSize, a bool other than 0/1, trailing bytes, and the kinds that have
//! a shorter way to be written (33, 35, 36, 37, 38). The format is betanet's node, backbone-flush
//! `flush-betanet` (`9cc49a8`, Flush 8.2.0); kind 38 is a launch with a fee split (upgrade v7).
//! Mainnet's is `main`'s (`95214ad`), the same today.
//!
//! Field values are JSON in the reference decoder's shape (#58): ids and other 32-byte values in
//! display order (byte-reversed, as the node's RPC shows them), scripts and blobs as hex.
use bitcoin::hashes::{sha256, Hash};
use serde_json::{json, Map, Value};

/// The tag a marker's push starts with.
pub const TAG: &[u8; 4] = b"BAST";

/// Listed outputs one marker may name (`MAX_MARKER_OUTPUTS`, `state.h`).
pub const MAX_LISTED: usize = 64;

/// A token's kind, as a listed output or a Burn names it (`TokenKind`, `state.h`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum TokenKind {
    Asset = 0,
    Control = 1,
    Reservation = 2,
    Lp = 3,
    Receipt = 4,
    Position = 5,
    Order = 6,
}

impl TokenKind {
    fn from_byte(b: u8) -> Option<Self> {
        use TokenKind::*;
        [Asset, Control, Reservation, Lp, Receipt, Position, Order].get(b as usize).copied()
    }

    /// The kind's name, as the node's RPC and the reference decoder write it.
    pub fn name(self) -> &'static str {
        ["asset", "control", "reservation", "lp", "receipt", "position", "order"][self as usize]
    }

    /// Whether a listed output of this kind carries an amount (`Token::Divisible`). Every other kind
    /// is exactly one.
    pub fn divisible(self) -> bool {
        matches!(self, TokenKind::Asset | TokenKind::Lp)
    }
}

/// A token: its kind, its id in display order, and its amount in base units.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Token {
    pub kind: TokenKind,
    pub id: String,
    pub amount: u64,
}

/// An output the marker names.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Listed {
    pub n: u32,
    /// The token it carries; None for a result, which only the node's state can tell.
    pub token: Option<Token>,
}

/// A parsed marker.
#[derive(Debug, Clone, PartialEq)]
pub struct Marker {
    /// The marker's own kind byte: 0 for a transfer (no operation), 33/35 for a Register with a
    /// logo or display name, 36/37/38 for a LaunchToken with parameters, the fee-flow fields or a fee split.
    pub kind: u8,
    /// The operation's name (`transfer` for kind 0).
    pub name: &'static str,
    /// The operation's fields, as a JSON object.
    pub fields: Map<String, Value>,
    pub outputs: Vec<Listed>,
    /// The logo's bytes, for a marker that sets one (kinds 32, 33, 35, and a launch's registration).
    pub logo: Option<Vec<u8>>,
}

impl Marker {
    /// The marker as the reference decoder writes it: `{kind, name, fields, outputs}`.
    pub fn to_json(&self) -> Value {
        let outputs: Vec<Value> = self
            .outputs
            .iter()
            .map(|o| match &o.token {
                Some(t) => json!({ "n": o.n, "carries": t.kind.name(), "id": t.id, "amount": t.amount }),
                None => json!({ "n": o.n, "carries": "result" }),
            })
            .collect();
        json!({ "kind": self.kind, "name": self.name, "fields": self.fields, "outputs": outputs })
    }

    /// A registration's facts, if this marker registers an asset (kinds 2, 33, 35) or launches a new
    /// one (22, 36, 37, 38), which registers it too.
    pub fn registration(&self) -> Option<Registration> {
        let reg = match self.kind {
            2 | 33 | 35 => &self.fields,
            22 | 36 | 37 | 38 => self.fields.get("reg")?.as_object()?,
            _ => return None,
        };
        let text = |key: &str| reg.get(key).and_then(Value::as_str).map(str::to_owned);
        Some(Registration {
            asset: text("asset")?,
            ticker: text("ticker"),
            display_name: text("display_name").filter(|s| !s.is_empty()),
            supply: reg.get("supply")?.as_u64()?,
            decimals: u8::try_from(reg.get("decimals")?.as_u64()?).ok()?,
        })
    }
}

/// What a registration says about its asset.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Registration {
    /// The id it registers, display order.
    pub asset: String,
    /// The ticker it names, if any (a registration may name only the id's hash).
    pub ticker: Option<String>,
    /// The display name it sets, if any (kinds 35, 22, 36, 37, 38).
    pub display_name: Option<String>,
    /// Base units.
    pub supply: u64,
    pub decimals: u8,
}

/// A ticker's asset id, display order: SHA-256 of the ticker's bytes, byte-reversed (`HashName`,
/// `state.cpp`).
pub fn asset_id(ticker: &str) -> String {
    let mut digest = sha256::Hash::hash(ticker.as_bytes()).to_byte_array();
    digest.reverse();
    crate::hex(&digest)
}

/// True if `script` claims to be a marker: `OP_RETURN` followed by a push that starts with the tag.
/// The node counts such a script as a marker even if it doesn't parse (`IsMarkerScript`), which
/// makes the transaction invalid.
pub fn is_marker(script: &[u8]) -> bool {
    lenient_push(script).is_some_and(|data| data.starts_with(TAG))
}

/// `script` → its marker, or why the node would refuse to read it.
pub fn parse(script: &[u8]) -> Result<Marker, String> {
    let data = push_data(script)?;
    let body = data.strip_prefix(TAG.as_slice()).ok_or("no BAST tag")?;
    let mut r = Reader { b: body, i: 0 };
    if r.u8()? != 0 {
        return Err("version is not 0".into());
    }
    let kind = r.u8()?;
    let mut logo = None;
    let (name, fields) = operation(&mut r, kind, &mut logo)?;
    canonical(kind, &fields)?;
    let count = r.compact()?;
    if count > MAX_LISTED as u64 {
        return Err(format!("more than {MAX_LISTED} listed outputs"));
    }
    let mut outputs = vec![];
    for _ in 0..count {
        let n = u32::try_from(r.varint(u32::MAX as u64)?).expect("bounded by u32::MAX");
        let k = r.u8()?;
        if k == 0xFF {
            outputs.push(Listed { n, token: None });
            continue;
        }
        let kind = TokenKind::from_byte(k).ok_or("unknown token kind")?;
        let id = r.u256()?;
        let amount = if kind.divisible() { r.varint(u64::MAX)? } else { 1 };
        outputs.push(Listed { n, token: Some(Token { kind, id, amount }) });
    }
    if r.i != r.b.len() {
        return Err("trailing bytes".into());
    }
    Ok(Marker { kind, name, fields, outputs, logo: logo.filter(|l: &Vec<u8>| !l.is_empty()) })
}

/// The bytes of `OP_RETURN <one push>`, refusing a push that isn't minimal or isn't all of `script`.
fn push_data(script: &[u8]) -> Result<&[u8], String> {
    let (len, at, op) = push_header(script).ok_or("not OP_RETURN and one push")?;
    let data = script.get(at..at + len).ok_or("push length runs past the script")?;
    if at + len != script.len() {
        return Err("bytes after the push".into());
    }
    let minimal = match len {
        0..=75 => 1,
        76..=0xFF => 0x4C,
        0x100..=0xFFFF => 0x4D,
        _ => 0x4E,
    };
    if (if op > 75 { op } else { 1 }) != minimal {
        return Err("the push isn't minimal".into());
    }
    Ok(data)
}

/// The push's bytes however it is written, for `is_marker`.
fn lenient_push(script: &[u8]) -> Option<&[u8]> {
    let (len, at, _) = push_header(script)?;
    script.get(at..(at + len).min(script.len()))
}

/// `OP_RETURN` then a push opcode → (length, where the data starts, the opcode).
fn push_header(script: &[u8]) -> Option<(usize, usize, u8)> {
    if script.first() != Some(&0x6A) {
        return None;
    }
    let op = *script.get(1)?;
    let le = |n: usize| script.get(2..2 + n).map(|b| b.iter().rev().fold(0usize, |acc, x| (acc << 8) | *x as usize));
    match op {
        1..=75 => Some((op as usize, 2, op)),
        0x4C => Some((le(1)?, 3, op)),
        0x4D => Some((le(2)?, 4, op)),
        0x4E => Some((le(4)?, 6, op)),
        _ => None,
    }
}

/// The kinds that have a shorter way to be written (`WriteOperation`, `state.cpp`).
fn canonical(kind: u8, fields: &Map<String, Value>) -> Result<(), String> {
    match kind {
        33 if fields["logo_bytes"] == 0 => Err("a Register with an empty logo is written as kind 2".into()),
        35 if fields["display_name"] == "" => Err("a Register with an empty display name is written as kind 33 or 2".into()),
        36 if fields["fee"] == 0 => Err("a LaunchToken with fee 0 is written as kind 22".into()),
        37 if fields["destination"] == 0 && fields["burn_bps"] == 0 && fields["keep_control"] == false => {
            Err("a LaunchToken without fee-flow fields is written as kind 22 or 36".into())
        }
        38 if fields["split"].as_array().is_some_and(Vec::is_empty) => Err("a LaunchToken without a fee split is written as kind 22, 36 or 37".into()),
        _ => Ok(()),
    }
}

/// The operation `kind` names and its fields.
/// `logo` gets the logo's bytes, for a kind that carries one.
fn operation(r: &mut Reader, kind: u8, logo: &mut Option<Vec<u8>>) -> Result<(&'static str, Map<String, Value>), String> {
    let mut f = Fields::default();
    let mut blob = |r: &mut Reader| -> Result<usize, String> {
        let bytes = r.blob()?;
        *logo = Some(bytes.to_vec());
        Ok(bytes.len())
    };
    let name = match kind {
        0 => "transfer",
        1 => {
            f.put("commitment", r.u256()?);
            "reserve"
        }
        2 => {
            register(r, &mut f)?;
            "register"
        }
        3 => {
            f.put("asset", r.u256()?).put("amount", r.varint(u64::MAX)?);
            "mint"
        }
        4 => {
            f.put("asset", r.u256()?).put("updates", asset_updates(r)?);
            "update_asset"
        }
        5 => {
            let tokens = r.vec(|r| {
                let kind = TokenKind::from_byte(r.u8()?).ok_or("unknown token kind")?;
                Ok(json!({ "kind": kind.name(), "id": r.u256()?, "amount": r.varint(u64::MAX)? }))
            })?;
            f.put("tokens", tokens);
            "burn"
        }
        6 => {
            f.put("asset_in", r.u256()?).put("amount_in", r.v()?).put("asset_out", r.u256()?).put("min_out", r.v()?).put("chn_to", r.blob_hex()?);
            "swap"
        }
        7 => {
            f.put("asset_a", r.u256()?).put("asset_b", r.u256()?).put("amount_a", r.v()?).put("amount_b", r.v()?).put("min_shares", r.v()?);
            "add_liquidity"
        }
        8 => {
            f.put("asset_a", r.u256()?).put("asset_b", r.u256()?).put("shares", r.v()?).put("min_a", r.v()?).put("min_b", r.v()?).put("chn_to", r.blob_hex()?);
            "remove_liquidity"
        }
        9 => {
            f.put("base", r.u256()?).put("base_amount", r.v()?).put("quote", r.u256()?).put("start_price", r.v()?).put("end_price", r.v()?);
            f.put("start_height", r.i32()?).put("duration", r.i32()?);
            "create_auction"
        }
        10 => {
            f.put("auction", r.u256()?).put("quote_amount", r.v()?).put("min_base", r.v()?).put("chn_to", r.blob_hex()?);
            "bid"
        }
        11 => {
            f.put("auction", r.u256()?).put("chn_to", r.blob_hex()?);
            "collect"
        }
        12 => {
            f.put("asset", r.u256()?);
            "release_asset"
        }
        13 => {
            f.put("path", r.vec(|r| r.u256().map(Value::from))?).put("amount_in", r.v()?).put("min_out", r.v()?).put("chn_to", r.blob_hex()?);
            "route"
        }
        14 => {
            f.put("name", r.string()?).put("pubkey", r.u256()?).put("proof", crate::hex(r.take(64)?));
            "register_oracle"
        }
        15 => {
            f.put("oracle", r.u256()?).put("event", r.u256()?).put("value", r.i64()?).put("height", r.i32()?).put("signature", crate::hex(r.take(64)?));
            "attest"
        }
        16 => {
            f.put("oracle", r.u256()?).put("event", r.u256()?).put("asset", r.u256()?).put("amount", r.v()?);
            let outcomes = r.vec(|r| Ok(json!({ "lo": r.i64()?, "hi": r.i64()?, "script": r.blob_hex()? })))?;
            f.put("outcomes", outcomes).put("refund", r.blob_hex()?).put("expiry", r.i32()?);
            "create_oracle_contract"
        }
        17 => {
            f.put("contract", r.u256()?);
            "settle_oracle_contract"
        }
        18 => {
            f.put("asset_a", r.u256()?).put("asset_b", r.u256()?).put("curve", r.u8()?).put("fee", r.v()?).put("amp", r.v()?);
            f.put("weight_a", r.u8()?).put("flags", r.u8()?).put("amount_a", r.v()?).put("amount_b", r.v()?).put("min_shares", r.v()?);
            "create_pool"
        }
        19 => {
            f.put("pool", r.u256()?).put("amount0", r.v()?).put("amount1", r.v()?).put("min_shares", r.v()?);
            "pool_deposit"
        }
        20 => {
            f.put("pool", r.u256()?).put("shares", r.v()?).put("only", r.u8()?).put("min0", r.v()?).put("min1", r.v()?).put("chn_to", r.blob_hex()?);
            "pool_withdraw"
        }
        21 => {
            f.put("asset_in", r.u256()?).put("pools", r.vec(|r| r.u256().map(Value::from))?).put("amount_in", r.v()?).put("min_out", r.v()?).put("chn_to", r.blob_hex()?);
            "swap_pools"
        }
        22 => {
            launch(r, &mut f, &mut blob)?;
            "launch_token"
        }
        23 => {
            f.put("token", r.u256()?);
            "claim_launch"
        }
        24 => {
            f.put("pool", r.u256()?).put("tick_lower", r.i32()?).put("tick_upper", r.i32()?).put("liquidity_hi", r.u64_le()?).put("liquidity_lo", r.u64_le()?);
            f.put("max0", r.v()?).put("max1", r.v()?).put("chn_to", r.blob_hex()?);
            "open_position"
        }
        25 => {
            f.put("position", r.u256()?).put("add", r.boolean()?).put("liquidity_hi", r.u64_le()?).put("liquidity_lo", r.u64_le()?);
            f.put("limit0", r.v()?).put("limit1", r.v()?).put("collect", r.boolean()?).put("close", r.boolean()?).put("chn_to", r.blob_hex()?);
            "change_position"
        }
        26 => {
            f.put("asset_sell", r.u256()?).put("asset_buy", r.u256()?).put("amount", r.v()?).put("price_num", r.v()?).put("price_den", r.v()?).put("expiry", r.i32()?);
            "place_order"
        }
        27 => {
            f.put("order", r.u256()?).put("cancel", r.boolean()?).put("chn_to", r.blob_hex()?);
            "settle_order"
        }
        28 => {
            f.put("asset", r.u256()?).put("amount", r.v()?).put("fee", r.v()?).put("creator", r.blob_hex()?).put("min_buy", r.v()?).put("max_buy", r.v()?);
            f.put("first_buy", r.v()?).put("first_min_out", r.v()?).put("chn_to", r.blob_hex()?);
            "curve_asset"
        }
        32 => {
            f.put("asset", r.u256()?).put("logo_bytes", blob(r)?);
            "set_logo"
        }
        33 => {
            register(r, &mut f)?;
            f.put("logo_bytes", blob(r)?);
            "register_with_logo"
        }
        34 => {
            f.put("asset", r.u256()?).put("display_name", r.string()?);
            "set_display_name"
        }
        35 => {
            register(r, &mut f)?;
            f.put("logo_bytes", blob(r)?).put("display_name", r.string()?);
            "register_with_display_name"
        }
        36 => {
            launch(r, &mut f, &mut blob)?;
            f.put("fee", r.v()?);
            "launch_with_params"
        }
        37 => {
            launch(r, &mut f, &mut blob)?;
            f.put("fee", r.v()?);
            let destination = r.u8()?;
            if destination > 2 {
                return Err("unknown fee destination".into());
            }
            f.put("destination", destination).put("burn_bps", r.u16()?).put("keep_control", r.boolean()?);
            "launch_fee_flow"
        }
        38 => {
            launch(r, &mut f, &mut blob)?;
            f.put("fee", r.v()?).put("keep_control", r.boolean()?);
            // Each share: its kind (0 the creator, 1 a buyback and burn, 2 an address), the script it pays, its basis points.
            let split = r.vec(|r| Ok(json!({ "kind": r.u8()?, "script": r.blob_hex()?, "bps": r.u16()? })))?;
            f.put("split", split);
            "launch_fee_split"
        }
        _ => return Err(format!("unknown operation kind {kind}")),
    };
    Ok((name, f.0))
}

fn register(r: &mut Reader, f: &mut Fields) -> Result<(), String> {
    f.put("asset", r.u256()?).put("nonce", r.u256()?).put("supply", r.v()?).put("decimals", r.u8()?).put("data", asset_data(r)?);
    let ticker = if r.boolean()? { r.string()? } else { Value::Null };
    f.put("ticker", ticker);
    Ok(())
}

/// A LaunchToken's fields (kinds 22, 36, 37, 38): its registration under `reg`, then the launch's own.
fn launch(r: &mut Reader, f: &mut Fields, logo: &mut impl FnMut(&mut Reader) -> Result<usize, String>) -> Result<(), String> {
    let mut reg = Fields::default();
    register(r, &mut reg)?;
    reg.put("logo_bytes", logo(r)?).put("display_name", r.string()?);
    f.put("reg", Value::Object(reg.0)).put("creator", r.blob_hex()?).put("allocation", r.u16()?);
    f.put("min_buy", r.v()?).put("max_buy", r.v()?).put("first_buy", r.v()?).put("first_min_out", r.v()?).put("chn_to", r.blob_hex()?);
    Ok(())
}

fn socket(r: &mut Reader, n: usize) -> Result<Value, String> {
    Ok(json!({ "ip": crate::hex(r.take(n)?), "port": r.u16()? }))
}

/// `AssetData`'s six fields, each optional.
fn asset_data(r: &mut Reader) -> Result<Value, String> {
    let mut f = Fields::default();
    for (key, read) in asset_fields() {
        let value = if r.boolean()? { read(r)? } else { Value::Null };
        f.put(key, value);
    }
    Ok(Value::Object(f.0))
}

/// `AssetUpdates`'s six fields, each `delete`, `retain` or `set` with a value.
fn asset_updates(r: &mut Reader) -> Result<Value, String> {
    let mut f = Fields::default();
    for (key, read) in asset_fields() {
        let update = match r.u8()? {
            0 => json!({ "kind": "delete" }),
            1 => json!({ "kind": "retain" }),
            2 => json!({ "kind": "set", "value": read(r)? }),
            _ => return Err("unknown update kind".into()),
        };
        f.put(key, update);
    }
    Ok(Value::Object(f.0))
}

type Read = fn(&mut Reader) -> Result<Value, String>;

fn asset_fields() -> [(&'static str, Read); 6] {
    [
        ("commitment", |r| r.u256().map(Value::from)),
        ("ipv4", |r| socket(r, 4)),
        ("ipv6", |r| socket(r, 16)),
        ("encryption_key", |r| Ok(crate::hex(r.take(33)?).into())),
        ("signing_key", |r| r.u256().map(Value::from)),
        ("info", |r| r.string()),
    ]
}

/// An operation's fields, in the order they're read.
#[derive(Default)]
struct Fields(Map<String, Value>);

impl Fields {
    fn put(&mut self, key: &str, value: impl Into<Value>) -> &mut Self {
        self.0.insert(key.into(), value.into());
        self
    }
}

/// Bitcoin Core's stream reader, for the encodings a marker uses (`serialize.h`).
struct Reader<'a> {
    b: &'a [u8],
    i: usize,
}

impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8], String> {
        let bytes = self.b.get(self.i..self.i.checked_add(n).ok_or("truncated")?).ok_or("truncated")?;
        self.i += n;
        Ok(bytes)
    }

    fn u8(&mut self) -> Result<u8, String> {
        Ok(self.take(1)?[0])
    }

    fn le<const N: usize>(&mut self) -> Result<[u8; N], String> {
        Ok(self.take(N)?.try_into().expect("took N bytes"))
    }

    fn u16(&mut self) -> Result<u16, String> {
        Ok(u16::from_le_bytes(self.le()?))
    }

    fn i32(&mut self) -> Result<i32, String> {
        Ok(i32::from_le_bytes(self.le()?))
    }

    fn i64(&mut self) -> Result<i64, String> {
        Ok(i64::from_le_bytes(self.le()?))
    }

    fn u64_le(&mut self) -> Result<u64, String> {
        Ok(u64::from_le_bytes(self.le()?))
    }

    /// A bool: 0 or 1, anything else fails the node's round trip.
    fn boolean(&mut self) -> Result<bool, String> {
        match self.u8()? {
            0 => Ok(false),
            1 => Ok(true),
            _ => Err("a bool other than 0 or 1".into()),
        }
    }

    /// Core's VARINT (`ReadVarInt`): base 128, most significant group first, plus one for every
    /// continuation byte, so each value has one encoding. Refuses values above `max`.
    fn varint(&mut self, max: u64) -> Result<u64, String> {
        let mut n: u64 = 0;
        loop {
            let ch = self.u8()?;
            if n > max >> 7 {
                return Err("VARINT too large".into());
            }
            n = (n << 7) | (ch & 0x7F) as u64;
            if ch & 0x80 == 0 {
                return if n > max { Err("VARINT too large".into()) } else { Ok(n) };
            }
            if n == max {
                return Err("VARINT too large".into());
            }
            n += 1;
        }
    }

    /// A u64 VARINT.
    fn v(&mut self) -> Result<u64, String> {
        self.varint(u64::MAX)
    }

    /// A canonical CompactSize no larger than Core's `MAX_SIZE`.
    fn compact(&mut self) -> Result<u64, String> {
        let (value, least) = match self.u8()? {
            f @ 0..=252 => return Ok(f as u64),
            253 => (u16::from_le_bytes(self.le()?) as u64, 253),
            254 => (u32::from_le_bytes(self.le()?) as u64, 0x1_0000),
            255 => (u64::from_le_bytes(self.le()?), 0x1_0000_0000),
        };
        if value < least {
            return Err("non-canonical CompactSize".into());
        }
        if value > 0x0200_0000 {
            return Err("CompactSize above MAX_SIZE".into());
        }
        Ok(value)
    }

    /// A uint256 (32 bytes, internal order) in display order.
    fn u256(&mut self) -> Result<String, String> {
        let mut bytes = self.le::<32>()?;
        bytes.reverse();
        Ok(crate::hex(&bytes))
    }

    fn blob(&mut self) -> Result<&'a [u8], String> {
        let n = self.compact()?;
        self.take(n as usize)
    }

    fn blob_hex(&mut self) -> Result<String, String> {
        Ok(crate::hex(self.blob()?))
    }

    /// A string: its text if UTF-8, else `{"hex": …}`.
    fn string(&mut self) -> Result<Value, String> {
        let bytes = self.blob()?;
        Ok(match std::str::from_utf8(bytes) {
            Ok(s) => s.into(),
            Err(_) => json!({ "hex": crate::hex(bytes) }),
        })
    }

    fn vec(&mut self, mut item: impl FnMut(&mut Self) -> Result<Value, String>) -> Result<Vec<Value>, String> {
        let n = self.compact()?;
        (0..n).map(|_| item(self)).collect()
    }
}

/// A transfer's marker (kind 0, no operation) listing `outputs`, each `(n, asset id in display
/// order, amount)`, as the node writes it (`MarkerScript`): the minimal push of its bytes.
/// `outputs` must be in increasing `n`, at most `MAX_LISTED`.
pub fn transfer_marker(outputs: &[(u32, &str, u64)]) -> Result<Vec<u8>, String> {
    if outputs.len() > MAX_LISTED {
        return Err(format!("more than {MAX_LISTED} listed outputs"));
    }
    if outputs.windows(2).any(|w| w[0].0 >= w[1].0) {
        return Err("listed outputs out of order".into());
    }
    let mut body = TAG.to_vec();
    body.extend([0, 0, outputs.len() as u8]);
    for &(n, id, amount) in outputs {
        body.extend(varint(n as u64));
        body.push(TokenKind::Asset as u8);
        body.extend(internal(id)?);
        body.extend(varint(amount));
    }
    marker_script(body)
}

/// A trade's marker (kind 21, `swap_pools`, as the node's `swaproute`, `buyfromlaunch` and
/// `selltolaunch` write it): `amount_in` of `asset_in` through `pools`, at least `min_out` out, ECX
/// paid out or back to `chn_to` (a script; empty when ECX is on neither side). `outputs` lists, in
/// increasing `n`, a token change `(asset id, amount)` or `None` for a result.
pub fn swap_pools_marker(asset_in: &str, pools: &[&str], amount_in: u64, min_out: u64, chn_to: &[u8], outputs: &[(u32, Option<(&str, u64)>)]) -> Result<Vec<u8>, String> {
    if outputs.len() > MAX_LISTED {
        return Err(format!("more than {MAX_LISTED} listed outputs"));
    }
    if outputs.windows(2).any(|w| w[0].0 >= w[1].0) {
        return Err("listed outputs out of order".into());
    }
    if pools.is_empty() || pools.len() > 0xFC || chn_to.len() > 0xFC {
        return Err("1 to 252 pools, and a short chn_to".into());
    }
    let mut body = TAG.to_vec();
    body.extend([0, 21]);
    body.extend(internal(asset_in)?);
    body.push(pools.len() as u8);
    for pool in pools {
        body.extend(internal(pool)?);
    }
    body.extend(varint(amount_in));
    body.extend(varint(min_out));
    body.push(chn_to.len() as u8);
    body.extend(chn_to);
    body.push(outputs.len() as u8);
    for &(n, token) in outputs {
        body.extend(varint(n as u64));
        match token {
            Some((id, amount)) => {
                body.push(TokenKind::Asset as u8);
                body.extend(internal(id)?);
                body.extend(varint(amount));
            }
            None => body.push(0xFF),
        }
    }
    marker_script(body)
}

/// A pool's kind (`PoolParams`, backbone-flush `state.h`), as `getpool` reports it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PoolKind {
    /// 0 constant product, 1 stable, 2 weighted, 3 a launch's curve, 4 concentrated, 5 an order book.
    pub curve: u8,
    /// Millionths.
    pub fee: u32,
    /// Stable pools' amplification; else 0.
    pub amp: u32,
    /// Weighted pools: the weight, in percent, of the asset whose id is lower (internal order); else 0.
    pub weight0: u8,
    /// Bit 0: the fee follows the pool's volatility.
    pub flags: u8,
}

/// The fee of every pool `addliquidity` makes (`LEGACY_FEE`: 0.3 %).
const LEGACY_FEE: u32 = 3000;

/// The id of the pool of `a` and `b` (display order, either way round) of `kind` (`PoolIdOf`,
/// backbone-flush `curves.cpp`), display order: SHA-256 of "Layers pool", the two ids lower first,
/// and the kind; for the kind `addliquidity` makes, of "BitAssets pool" and the ids (`PoolId`).
pub fn pool_id(a: &str, b: &str, kind: &PoolKind) -> Result<String, String> {
    let (a, b) = (internal(a)?, internal(b)?);
    let (lo, hi) = if a <= b { (a, b) } else { (b, a) };
    let legacy = kind.curve == 0 && kind.fee == LEGACY_FEE && kind.flags == 0;
    let tag: &[u8] = if legacy { b"BitAssets pool" } else { b"Layers pool" };
    let mut data = vec![tag.len() as u8];
    data.extend(tag);
    data.extend(lo);
    data.extend(hi);
    if !legacy {
        data.push(kind.curve);
        data.extend(kind.fee.to_le_bytes());
        data.extend(kind.amp.to_le_bytes());
        data.extend([kind.weight0, kind.flags]);
    }
    let mut digest = sha256::Hash::hash(&data).to_byte_array();
    digest.reverse();
    Ok(crate::hex(&digest))
}

/// An id in display hex, in internal order.
fn internal(id: &str) -> Result<Vec<u8>, String> {
    let mut bytes: Vec<u8> = (0..id.len()).step_by(2).map(|i| u8::from_str_radix(id.get(i..i + 2).unwrap_or("x"), 16)).collect::<Result<_, _>>().map_err(|_| "an id is hex")?;
    if bytes.len() != 32 {
        return Err("an id is 32 bytes".into());
    }
    bytes.reverse();
    Ok(bytes)
}

/// `OP_RETURN` and the minimal push of `body` (`MarkerScript`).
fn marker_script(body: Vec<u8>) -> Result<Vec<u8>, String> {
    let mut script = vec![0x6A];
    match body.len() {
        0..=75 => script.push(body.len() as u8),
        76..=0xFF => script.extend([0x4C, body.len() as u8]),
        _ => return Err("the marker is too large".into()),
    }
    script.extend(body);
    Ok(script)
}

/// Core's VARINT (`WriteVarInt`).
fn varint(mut n: u64) -> Vec<u8> {
    let mut bytes = vec![(n & 0x7F) as u8];
    while n > 0x7F {
        n = (n >> 7) - 1;
        bytes.insert(0, (n & 0x7F) as u8 | 0x80);
    }
    bytes
}
