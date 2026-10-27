// The Activity tab's feed (no browser needed): every chain's transactions in one list, the
// unconfirmed first, then one section per day, newest first; and what kind each one is.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { importWallet } from "../harness.mjs";

const { activityKind, activityDays } = await importWallet();

const at = (iso) => Date.parse(iso) / 1000;
const entry = (txid, amounts, extra = {}) => ({ txid, amounts: amounts.map((amount) => ({ asset: "", amount })), confirmed: true, ...extra });
const utcDay = (seconds) => new Date(seconds * 1000).toISOString().slice(0, 10);

describe("activityKind", () => {
  test("names what a transaction did for the wallet", () => {
    assert.equal(activityKind(entry("a", ["5000"])), "received");
    assert.equal(activityKind(entry("a", ["-5000"])), "sent");
    assert.equal(activityKind(entry("a", ["-5000", "7"])), "sent", "anything leaving makes it a send");
    assert.equal(activityKind(entry("a", ["-120"], { toSelf: true })), "toSelf");
    assert.equal(activityKind(entry("a", ["-41000"], { depositTo: 24 })), "deposit");
    assert.equal(activityKind(entry("a", [], { hidden: true })), "confidential", "nothing but confidential amounts");
    const trade = { pool: "77".repeat(32), given: { asset: "", amount: "100000" }, fee: "400", outcome: { state: "settling" } };
    assert.equal(activityKind(entry("a", ["-100400"], { trade })), "trade", "a Flush trade is a trade, whatever left");
  });
});

describe("activityDays", () => {
  test("merges chains: unconfirmed first, then a section per day, newest first", () => {
    const main = [
      entry("m-pending", ["900"], { confirmed: false, trusted: false }),
      entry("m-yesterday", ["-250412"], { time: at("2026-10-20T09:00:00Z") }),
      entry("m-old", ["353100"], { time: at("2026-10-18T12:00:00Z") }),
    ];
    const elements = [
      entry("e-pending", ["-1500000"], { confirmed: false, trusted: true }),
      entry("e-today", ["1000"], { time: at("2026-10-21T08:00:00Z") }),
      entry("e-yesterday-late", ["49750120"], { time: at("2026-10-20T22:00:00Z") }),
    ];
    const days = activityDays(
      [
        { chain: "l1", entries: main },
        { chain: 24, entries: elements },
      ],
      utcDay,
    );
    assert.deepEqual(
      days.map(({ day, items }) => [day, items.map((i) => `${i.chain}:${i.entry.txid}`)]),
      [
        ["unconfirmed", ["l1:m-pending", "24:e-pending"]],
        ["2026-10-21", ["24:e-today"]],
        ["2026-10-20", ["24:e-yesterday-late", "l1:m-yesterday"]],
        ["2026-10-18", ["l1:m-old"]],
      ],
    );
  });

  test("nothing to show is no sections", () => {
    assert.deepEqual(activityDays([{ chain: "l1", entries: [] }], utcDay), []);
  });
});
