// Seam 1, kept history's storage (#94, docs/adr/0020): how often `addressHistory` reads and writes
// an address's kept list in its `historyStore`. No browser: the wallet's TypeScript against the
// stub Esplora server, with an in-memory store that counts what touches the kept-history key.
//
// A refresh reads the kept list once. It's rewritten only once `KEEP_BATCH` (25) newly settled
// transactions are left out of it, or when Show older read further back, or when it's dropped or
// replaced; settled ones not yet written are read from the server again, being newer than it.
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { createEsploraStub } from "@ecx/stub-server/esplora";
import { addressScript, encodeTx, parseTx } from "@ecx/stub-server/bitcoin-tx";
import { importWallet } from "../harness.mjs";

const wallet = await importWallet();

const L1_FORK_BLOCK = { height: 967680, hash: "00000000000000030101ba5cfea54b22becc79f95dc6040beb76e01dd9d04042" };
const ADDRESS = "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu";
/** Deep enough to keep every transaction below 979991 (`KEPT_DEPTH`, 10 blocks). */
const TIP = 980000;

/** A transaction paying `ADDRESS`, confirmed at `blockHeight`; `seed` keeps txids apart. */
const tx = (seed, blockHeight, value = 1000) => {
  const hex = encodeTx({ inputs: [{ txid: seed.padStart(64, "0"), vout: 0 }], outputs: [{ value, script: addressScript(ADDRESS) }] });
  return { hex, txid: parseTx(hex).txid, confirmed: true, blockHeight, blockTime: 1792000000 };
};
/** `count` settled transactions from `from` up, one a block. */
const history = (count, from = 970000, tag = "a") => Array.from({ length: count }, (_, i) => tx(`${tag}${from + i}`, from + i));

/** An in-memory `historyStore` that counts reads and writes of kept history. */
function countingStore(memory = new Map()) {
  const counts = { reads: 0, writes: 0 };
  return {
    memory,
    counts,
    reset: () => Object.assign(counts, { reads: 0, writes: 0 }),
    get: async (key) => {
      if (key.includes(":address-history:")) counts.reads++;
      return structuredClone(memory.get(key));
    },
    set: async (key, value) => {
      if (key.includes(":address-history:")) counts.writes++;
      memory.set(key, structuredClone(value));
    },
  };
}

const config = { identityBlock: L1_FORK_BLOCK, tipHeight: TIP, txs: [] };
let stub;
let url;
before(async () => {
  stub = createEsploraStub(config);
  url = await stub.listen();
});
after(() => stub?.close());
beforeEach(() => {
  config.txs = [];
});

const client = (store) => wallet.esploraClient({ url, identityBlock: L1_FORK_BLOCK, chainName: "eCash", historyStore: store }, (...args) => fetch(...args));
/** The txids the server lists for `ADDRESS`, newest first. */
const listed = () => [...config.txs].sort((a, b) => b.blockHeight - a.blockHeight).map((t) => t.txid);
/** The txids `store` keeps, newest first. */
const kept = (store) => [...store.memory.values()][0]?.txs.map((t) => t.txid);

describe("kept history's reads and writes", () => {
  test("a refresh with nothing new reads kept history once and doesn't write it", async () => {
    config.txs = history(30);
    const store = countingStore();
    const esplora = client(store);
    await esplora.addressHistory(ADDRESS);
    assert.equal(store.counts.writes, 1, "the first read keeps what settled");
    store.reset();
    const again = await esplora.addressHistory(ADDRESS);
    assert.deepEqual(again.txs.map((t) => t.txid), listed());
    assert.deepEqual(store.counts, { reads: 1, writes: 0 });
  });

  test("newly settled transactions are written once 25 have piled up; until then they're read from the server, and the history stays whole", async () => {
    config.txs = history(30);
    const store = countingStore();
    await client(store).addressHistory(ADDRESS);
    const first = kept(store);
    for (let i = 1; i <= 24; i++) {
      config.txs = [...config.txs, tx(`b${i}`, 970100 + i)];
      store.reset();
      // A fresh client each time, as after a restart: only the store carries over.
      const read = await client(store).addressHistory(ADDRESS);
      assert.deepEqual(read.txs.map((t) => t.txid), listed(), `refresh ${i}: every transaction, newest first`);
      assert.equal(read.complete, true);
      assert.deepEqual(store.counts, { reads: 1, writes: 0 }, `refresh ${i}: ${i} new, not written yet`);
      assert.deepEqual(kept(store), first);
    }
    config.txs = [...config.txs, tx("b25", 970125)];
    store.reset();
    const read = await client(store).addressHistory(ADDRESS);
    assert.deepEqual(read.txs.map((t) => t.txid), listed());
    assert.equal(store.counts.writes, 1, "the 25th is written, with the 24 before it");
    assert.deepEqual(kept(store), listed());
  });

  test("one not yet settled isn't kept, nor counted towards a write", async () => {
    config.txs = history(30);
    const store = countingStore();
    await client(store).addressHistory(ADDRESS);
    // 20 settled and 9 under 10 blocks deep: 29 new, but only 20 to keep.
    config.txs = [...config.txs, ...history(20, 970200, "c"), ...Array.from({ length: 9 }, (_, i) => tx(`f${i}`, TIP - i))];
    store.reset();
    const read = await client(store).addressHistory(ADDRESS);
    assert.deepEqual(read.txs.map((t) => t.txid), listed());
    assert.deepEqual(store.counts, { reads: 1, writes: 0 });
  });

  test("what Show older read is written at once", async () => {
    config.txs = history(25 * (wallet.HISTORY_PAGES + 1) + 40);
    const store = countingStore();
    const esplora = client(store);
    await esplora.addressHistory(ADDRESS);
    assert.equal(kept(store).length, 25 * (wallet.HISTORY_PAGES + 1));
    store.reset();
    const older = await esplora.addressHistory(ADDRESS, { older: true });
    assert.equal(older.txs.length, config.txs.length);
    assert.equal(store.counts.writes, 1);
    assert.deepEqual(kept(store), listed());
  });

  test("a list the server no longer lists is replaced at once", async () => {
    config.txs = history(30);
    const store = countingStore();
    await client(store).addressHistory(ADDRESS);
    config.txs = history(3, 975000, "d");
    store.reset();
    const read = await client(store).addressHistory(ADDRESS);
    assert.deepEqual(read.txs.map((t) => t.txid), listed());
    assert.equal(store.counts.writes, 1);
    assert.deepEqual(kept(store), listed());
  });

  test("a write doesn't undo what a read alongside kept further back (Show older beside a refresh)", async () => {
    config.txs = history(25 * (wallet.HISTORY_PAGES + 1) + 40);
    const memory = new Map();
    await client(countingStore(memory)).addressHistory(ADDRESS);
    // 25 newly settled: the refresh writes. It read the kept list before Show older wrote further back.
    config.txs = [...config.txs, ...Array.from({ length: 25 }, (_, i) => tx(`e${i}`, 971000 + i))];
    let olderDone;
    const done = new Promise((resolve) => (olderDone = resolve));
    const slow = countingStore(memory);
    let first = true;
    const stale = {
      get: async (key) => {
        const value = await slow.get(key);
        if (first) {
          first = false;
          await done;
        }
        return value;
      },
      set: slow.set,
    };
    const refresh = client(stale).addressHistory(ADDRESS);
    await client(countingStore(memory)).addressHistory(ADDRESS, { older: true });
    olderDone();
    await refresh;
    assert.deepEqual([...memory.values()][0].txs.map((t) => t.txid), listed(), "the new ones, and all Show older read");
  });
});
