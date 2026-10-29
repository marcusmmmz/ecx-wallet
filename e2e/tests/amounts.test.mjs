// How the wallet shows amounts (no browser needed): every ECX amount in the one unit the user
// picked, ECX or sats; other assets the Chain Entry names in whole units with their ticker; unknown
// assets in base units. And the one total across chains: each chain's ECX, as its Chain Entry names
// it (docs/adr/0005).
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { importWallet } from "../harness.mjs";

const { formatAllDecimals, formatAmount, parseAmount, totalAcrossChains, createSettings } = await importWallet();

const ECX_L1 = { id: "", ticker: "ECX", name: "eCash", decimals: 8, ecx: true };
const POLICY_ASSET = "5836dcc06130dcf6a65b6ac493813fd65559955283e44cc3f07966294eccb2c8";
const ECX_S24 = { id: POLICY_ASSET, ticker: "ECX", name: "eCash on Elements+", decimals: 8, ecx: true };
const TOKEN = { id: "22".repeat(32), ticker: "TOK", name: "A token", decimals: 2 };
const UNKNOWN = "11".repeat(32);

describe("formatAllDecimals", () => {
  test("keeps every decimal place, so a new asset's precision shows", () => {
    assert.equal(formatAllDecimals("1000000", 8, "EXA"), "0.01000000 EXA");
    assert.equal(formatAllDecimals("6942000000000", 8, "EXA"), "69,420.00000000 EXA");
    assert.equal(formatAllDecimals("0", 2, "USD"), "0.00 USD");
    assert.equal(formatAllDecimals("1234567", 0, "PTS"), "1,234,567 PTS");
  });
});

describe("formatAmount", () => {
  test("ECX in whole coins, trailing zeros dropped and thousands grouped", () => {
    assert.equal(formatAmount("102500", ECX_L1, "ecx"), "0.001025 ECX");
    assert.equal(formatAmount("48250000", ECX_S24, "ecx"), "0.4825 ECX");
    assert.equal(formatAmount("100000000", ECX_S24, "ecx"), "1 ECX");
    assert.equal(formatAmount("12345678900000", ECX_L1, "ecx"), "123,456.789 ECX");
    assert.equal(formatAmount("0", ECX_L1, "ecx"), "0 ECX");
  });

  test("ECX in sats, grouped", () => {
    assert.equal(formatAmount("102500", ECX_L1, "sats"), "102,500 sats");
    assert.equal(formatAmount("900", ECX_S24, "sats"), "900 sats");
  });

  test("a negative amount keeps its sign, as a minus", () => {
    assert.equal(formatAmount("-250412", ECX_L1, "ecx"), "−0.00250412 ECX");
    assert.equal(formatAmount("-250412", ECX_L1, "sats"), "−250,412 sats");
  });

  test("another named asset is in whole units with its ticker, whatever the unit", () => {
    assert.equal(formatAmount("1050", TOKEN, "ecx"), "10.5 TOK");
    assert.equal(formatAmount("1050", TOKEN, "sats"), "10.5 TOK");
  });

  test("an unknown asset is in base units, with no ticker", () => {
    assert.equal(formatAmount("1000", undefined, "ecx"), "1,000");
    assert.equal(formatAmount("7", undefined, "sats"), "7");
  });
});

describe("parseAmount", () => {
  test("reads ECX in the unit the user picked, into base units", () => {
    assert.equal(parseAmount("0.0005", ECX_L1, "ecx"), "50000");
    assert.equal(parseAmount("1", ECX_L1, "ecx"), "100000000");
    assert.equal(parseAmount("1,234.5", ECX_L1, "ecx"), "123450000000");
    assert.equal(parseAmount(" .5 ", ECX_L1, "ecx"), "50000000");
    assert.equal(parseAmount("50000", ECX_L1, "sats"), "50000");
    assert.equal(parseAmount("50,000", ECX_L1, "sats"), "50000");
  });

  test("reads another named asset in whole units, and an unknown one in base units", () => {
    assert.equal(parseAmount("10.5", TOKEN, "sats"), "1050");
    assert.equal(parseAmount("1000", undefined, "ecx"), "1000");
  });

  test("refuses more decimals than the unit has, and anything that isn't a positive amount", () => {
    assert.throws(() => parseAmount("0.000000001", ECX_L1, "ecx"), /at most 8 decimal places/);
    assert.throws(() => parseAmount("1.5", ECX_L1, "sats"), /whole number of sats/);
    assert.throws(() => parseAmount("1.5", undefined, "ecx"), /whole number/);
    for (const text of ["", "abc", "-1", "1e5", "0", "0.0", "1.2.3"]) assert.throws(() => parseAmount(text, ECX_L1, "ecx"), Error, text);
  });

  test("round-trips with formatAmount", () => {
    for (const amount of ["1", "50000", "100000000", "123456789012345678"]) {
      for (const unit of ["ecx", "sats"]) {
        const shown = formatAmount(amount, ECX_L1, unit).replace(/ (ECX|sats)$/, "");
        assert.equal(parseAmount(shown, ECX_L1, unit), amount, `${amount} in ${unit}`);
      }
    }
  });
});

describe("totalAcrossChains", () => {
  const report = (balances, unconfirmed = []) => ({ chain: "x", server: "s", readAt: 0, balances, unconfirmed });

  test("adds each chain's ECX, confirmed and unconfirmed apart, and nothing else", () => {
    const total = totalAcrossChains([
      { name: "Main chain", assets: [ECX_L1], report: report([{ asset: "", amount: "102500" }], [{ asset: "", amount: "900" }]) },
      {
        name: "Elements+",
        assets: [ECX_S24, TOKEN],
        report: report([
          { asset: POLICY_ASSET, amount: "48250000" },
          { asset: TOKEN.id, amount: "5" },
          { asset: UNKNOWN, amount: "1000" },
        ]),
      },
    ]);
    assert.deepEqual(total, { amount: "48352500", unconfirmed: "900", unavailable: [] });
  });

  test("a chain whose ECX can't be read is listed as unavailable, not counted", () => {
    const total = totalAcrossChains([
      { name: "Main chain", assets: [ECX_L1], report: undefined },
      { name: "Elements+", assets: [ECX_S24], report: report([{ asset: POLICY_ASSET, amount: "7" }]) },
    ]);
    assert.deepEqual(total, { amount: "7", unconfirmed: "0", unavailable: ["Main chain"] });
  });

  test("a chain that names no ECX adds nothing and is never unavailable", () => {
    const total = totalAcrossChains([{ name: "Tokens", assets: [TOKEN], report: undefined }]);
    assert.deepEqual(total, { amount: "0", unconfirmed: "0", unavailable: [] });
  });

  test("amounts beyond 2^53 add exactly", () => {
    const big = "9007199254740993";
    const total = totalAcrossChains([
      { name: "a", assets: [ECX_L1], report: report([{ asset: "", amount: big }]) },
      { name: "b", assets: [ECX_S24], report: report([{ asset: POLICY_ASSET, amount: big }]) },
    ]);
    assert.equal(total.amount, "18014398509481986");
  });
});

describe("the unit setting", () => {
  const memoryStore = () => {
    const data = new Map();
    return { get: async (k) => data.get(k), set: async (k, v) => void data.set(k, v), remove: async (k) => void data.delete(k), keys: async () => [...data.keys()] };
  };

  test("is ECX until the user picks sats, and remembers the pick", async () => {
    const store = memoryStore();
    assert.equal(await createSettings(store).unit(), "ecx");
    await createSettings(store).setUnit("sats");
    assert.equal(await createSettings(store).unit(), "sats");
    await createSettings(store).setUnit("ecx");
    assert.equal(await createSettings(store).unit(), "ecx");
  });

  test("refuses any other unit, and reads a stored one it doesn't know as ECX", async () => {
    const store = memoryStore();
    await assert.rejects(createSettings(store).setUnit("btc"), /unit/);
    await store.set("settings:unit", "btc");
    assert.equal(await createSettings(store).unit(), "ecx");
  });
});
