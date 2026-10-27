// Flush (Slot 99 on betanet, docs/adr/0014) over its explorer, in node: the wallet's own TypeScript and the shipped flush.wasm
// against the Esplora stub in Flush mode (mempool.space's electrs fork plus `/flush/blocks`), with a
// scripted approval window instead of a browser. Balance, history, Send, finality and the stall
// (#56, docs/adr/0012); token balances, names from their registration (#58) and token Sends (#59,
// docs/adr/0013); Deposit credits, which Flush pays as coinbase outputs (#57).
// Fixtures are made here: no plain ECX transfer exists on the live chain.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { createEsploraStub } from "@ecx/stub-server/esplora";
import { encodeTx, parseTx } from "@ecx/stub-server/bitcoin-tx";
import { DIST, importWallet, ROOT } from "../harness.mjs";

const wallet = await importWallet();
const flush = await wallet.loadChainModule(await readFile(path.join(DIST.chromium, "flush.wasm")));
const l1 = await wallet.loadL1Module(await readFile(path.join(DIST.chromium, "l1.wasm")));

const STARTER = "buyer citizen congress doll secret merry denial law live wait pass drive";
const FOREIGN = "blush cream bullet drive index disease noble east target dice put rate";
const CHAIN = "ecash:betanet-s99";
const { identityBlock } = flush.chainEntry().networks.betanet;
/** The betanet genesis Backbone derives for Slot 46, mainnet's Flush: same HRP, another chain. */
const SLOT_46_GENESIS = "7d66b10e351e5ad86c562ba761b5476f75c6f1b9f13aa7cf469df3a8d5701b75";

const account = flush.deriveAccount(STARTER, { receive: wallet.WATCHED_RECEIVE_ADDRESSES, change: wallet.WATCHED_CHANGE_ADDRESSES });
const [RECEIVE_0, RECEIVE_1] = account.receive;
const PAY_TO = flush.deriveAccount(FOREIGN, { receive: 1 }).receive[0].address;

const SOFT = "50".repeat(32);
const ANCHORED = "a0".repeat(32);
const FINAL = "f0".repeat(32);

/** A coinbase paying `outputs` (`[script, value]`): how Flush pays a Deposit, at `height`. */
const coinbase = (height, outputs) =>
  encodeTx({
    inputs: [{ txid: "00".repeat(32), vout: 0xffffffff, script: `03${height.toString(16).padStart(6, "0")}` }],
    outputs: outputs.map(([script, value]) => ({ script, value })),
  });

/** A plain transaction paying `outputs`, from a made-up input (`seed` keeps txids apart). */
const paying = (seed, outputs) => encodeTx({ inputs: [{ txid: seed.repeat(32), vout: 0 }], outputs: outputs.map(([script, value]) => ({ script, value })) });

const lockState = () => ({ unlocked: true, steps: [] });

/** BROSEVELT, a live Slot 99 asset, and the transaction that registered it (core/flush/tests). */
const BROSEVELT = "7351ccd9fd2f091cce3f9d8e3cd0b95f278885f4610620784b8c64be8b0237c1";
const BROSEVELT_REGISTRATION = "24fc101fccc71bc60845e190c2ad1e07b332fe7a6de99af37acdaaefdd9db891";
/** BROSEVELT's SetLogo: the whole JPEG in its marker. */
const BROSEVELT_LOGO = "7958bc9b161e2bacc98e66bd7c6a01457809817a4c0cfcecc749504ad38e8d44";
const LIVE_TXS = JSON.parse(await readFile(path.join(ROOT, "core/flush/tests/token-txs.json"), "utf8"));
/** FORK, a live launch on Slot 99: its registration and its launch's pool, as getpool answers (core/flush/tests). */
const TRADE = JSON.parse(await readFile(path.join(ROOT, "core/flush/tests/trade-fixtures.json"), "utf8"));
const FORK = "6bb2ae6e23e626cd2fba1f8845d8bbc047aeb9a8f4690ee9a21b5d04584dfb03";
const FORK_POOL = "2b16f8c06c0f98034bacfe23cec9e36ce96b3d1282766dd957901435354b402a";
const DEX = "https://flush.markets";

/** Core's VARINT (serialize.h): base 128, most significant group first, one less per continuation byte. */
function varint(n) {
  let x = BigInt(n);
  const bytes = [Number(x & 0x7fn)];
  while (x > 0x7fn) {
    x = (x >> 7n) - 1n;
    bytes.unshift(Number((x & 0x7fn) | 0x80n));
  }
  return bytes;
}

/**
 * A `BAST` marker's script (docs/adr/0013): `kind` with `fields` (bytes), listing each output as
 * `{ n, asset, amount }` (an asset token) or `{ n }` (a result).
 */
function marker(kind, fields, listed) {
  const internal = (id) => Buffer.from(id, "hex").reverse();
  const body = [...Buffer.from("BAST"), 0, kind, ...fields, listed.length];
  for (const { n, asset, amount } of listed) body.push(...varint(n), ...(asset === undefined ? [0xff] : [0, ...internal(asset), ...varint(amount)]));
  const push = body.length <= 75 ? [body.length] : [0x4c, body.length];
  return Buffer.from([0x6a, ...push, ...body]).toString("hex");
}

describe("Flush", () => {
  const config = { flush: true, identityBlock, tipHeight: 500, feeEstimates: { 1: 1, 6: 0.1, 1008: 0.1 }, txs: [], utxos: {} };
  let stub;
  let url;
  before(async () => {
    stub = createEsploraStub(config);
    url = await stub.listen();
  });
  after(() => stub?.close());

  /** Flush's module with betanet's server on the stub. */
  function module() {
    const entry = structuredClone(flush.chainEntry());
    entry.networks.betanet.sidechainServer = { api: "flush", url };
    return { ...flush, chainEntry: () => structuredClone(entry) };
  }

  /** `txs` (with their blocks) in the stub, and each output they pay one of our addresses as a coin. */
  function fund(txs) {
    config.txs = txs;
    config.utxos = {};
    for (const { hex, confirmed = true, blockHash } of txs) {
      const tx = parseTx(hex);
      tx.outputs.forEach(({ script, value }, vout) => {
        const ours = [...account.receive, ...account.change].find((a) => a.scriptPubkey === script);
        if (ours) (config.utxos[ours.address] ??= []).push({ txid: tx.txid, vout, value, confirmed, blockHash });
      });
    }
  }

  function pullPathWith({ lock = lockState(), prompts = [], tokens } = {}) {
    const flushModule = module();
    const deps = {
      supportedSlots: [99],
      chainModule: (slot) => (slot === 99 ? Promise.resolve(flushModule) : undefined),
      openSigningApproval: (context) => ({
        unlock: async () => true,
        confirm: async (prompt) => {
          prompts.push({ context, prompt });
          return true;
        },
        close() {},
      }),
      isUnlocked: async () => lock.unlocked,
      starter: async () => STARTER,
      l1Module: async () => l1,
      l1AccountKey: async () => assert.fail("Flush asked for the L1 Account Key"),
      now: () => Date.now(),
      sidechainServer: (entry, network) => wallet.sidechainServer(entry, network, undefined, undefined, tokens),
    };
    return { pullPath: wallet.createPullPath(deps), deps, prompts };
  }

  function sendsWith({ held = [], used = new Set() } = {}) {
    const { pullPath, deps, prompts } = pullPathWith();
    const sends = wallet.createSends({
      ...deps,
      pullPath,
      esplora: (entry, network) => wallet.esploraClient(wallet.esploraConfig(entry, network), (...args) => fetch(...args)),
      held: {
        list: async () => [...held],
        put: async (h) => void held.push(h),
        remove: async (txid) => void held.splice(held.findIndex((h) => h.txid === txid), 1),
      },
      usedLinks: { has: async (d) => used.has(d), add: async (d) => void used.add(d) },
      now: () => Date.now(),
    });
    return { sends, prompts, held, used };
  }

  test("a server on another Flush chain fails the identity check", async () => {
    config.identityBlock = { height: 0, hash: SLOT_46_GENESIS };
    try {
      await assert.rejects(pullPathWith().pullPath.reportedState(99), /is on another chain: its genesis block is 7d66b10e/);
    } finally {
      config.identityBlock = identityBlock;
    }
  });

  test("the balance counts Deposit payouts in coinbases, and a soft block's as preconf", async () => {
    fund([
      { hex: coinbase(100, [["", 0], [RECEIVE_0.scriptPubkey, 100_000_000]]), blockHeight: 100, blockHash: FINAL },
      { hex: coinbase(490, [[RECEIVE_1.scriptPubkey, 2_000]]), blockHeight: 490, blockHash: ANCHORED },
      { hex: paying("e1", [[RECEIVE_0.scriptPubkey, 5_000]]), blockHeight: 499, blockHash: SOFT },
      // A token's output: value 0, counted as nothing.
      { hex: paying("e2", [[RECEIVE_1.scriptPubkey, 0]]), blockHeight: 300, blockHash: FINAL },
    ]);
    config.finality = { [SOFT]: "soft", [ANCHORED]: "anchored" };
    const report = await pullPathWith().pullPath.reportedState(99);
    assert.deepEqual(report.balances, [{ asset: "", amount: "100007000" }], "a soft block's payment counts");
    assert.deepEqual(report.preconfirmed, [{ asset: "", amount: "5000" }], "and is marked preconf until anchored");
    assert.deepEqual(report.unconfirmed, []);
    assert.equal(report.stalledSince, undefined);
    const history = await pullPathWith().pullPath.history(99);
    assert.deepEqual(
      history.entries.map((e) => [e.amounts[0]?.amount, e.confirmed, e.preconfirmed]),
      [["5000", true, true], ["2000", true, undefined], [undefined, true, undefined], ["100000000", true, undefined]],
    );

    config.finality = {};
    const anchored = await pullPathWith().pullPath.reportedState(99);
    assert.deepEqual([anchored.balances, anchored.preconfirmed], [[{ asset: "", amount: "100007000" }], undefined]);
  });

  test("the history lists coinbase receipts and pages with after_txid past the first 25", async () => {
    fund(Array.from({ length: 40 }, (_, i) => ({ hex: coinbase(1000 + i, [[RECEIVE_0.scriptPubkey, 1_000 + i]]), blockHeight: 1000 + i, blockHash: FINAL })));
    const history = await pullPathWith().pullPath.history(99);
    assert.equal(history.entries.length, 40);
    assert.equal(history.partial, false);
    assert.deepEqual(history.entries[0].amounts, [{ asset: "", amount: "1039" }], "newest first");
    assert.ok(stub.requests().some((p) => p.endsWith("/txs/chain/" + history.entries[24].txid)), "Blockstream's paging was tried first");
  });

  test("a Send builds from whole transactions, never spends a value-0 output, and goes out without a replay marker", async () => {
    const coin = paying("c1", [[RECEIVE_0.scriptPubkey, 100_000]]);
    const token = paying("c2", [[RECEIVE_1.scriptPubkey, 0]]);
    fund([
      { hex: coin, blockHeight: 400, blockHash: FINAL },
      { hex: token, blockHeight: 401, blockHash: FINAL },
    ]);
    const { sends, prompts, held } = sendsWith();
    const before = stub.broadcasts().length;
    const result = await sends.send(99, { outputs: [{ asset: "", amount: "40000", to: { address: PAY_TO } }] });

    assert.equal(prompts.length, 1);
    assert.deepEqual(prompts[0].context, { origin: "This wallet (Send on Flush)", chain: CHAIN });
    const { view } = prompts[0].prompt.decoded;
    assert.equal(prompts[0].prompt.decoded.kind, "clear");
    assert.deepEqual(view.outputs[0], { index: 0, asset: "", amount: "40000", destination: { kind: "address", address: PAY_TO, yours: false } });
    assert.equal(view.outputs[1].destination.yours, true, "change comes back");
    // 0.1 sat/vB estimates: the module pays 1 sat/vB, about 141 vB here.
    assert.ok(Number(view.fee.amount) >= 141, `fee ${view.fee.amount}`);

    assert.equal(stub.broadcasts().length, before + 1);
    const tx = parseTx(stub.broadcasts().at(-1));
    assert.deepEqual(result, { server: url, accepted: true, txid: tx.txid });
    assert.equal(tx.locktime, 0, "no replay marker on Flush (docs/adr/0011)");
    assert.deepEqual(tx.inputs.map((i) => i.txid), [parseTx(coin).txid], "the value-0 output is never spent");
    assert.equal(tx.inputs[0].witness.length, 2, "signed by flush.wasm");
    assert.deepEqual(held, [{ slot: 99, txid: tx.txid, spent: [{ txid: parseTx(coin).txid, vout: 0 }], tipHeight: 500 }]);
  });

  test("a coin someone else paid in a soft block (preconf) can be spent", async () => {
    fund([{ hex: paying("d1", [[RECEIVE_0.scriptPubkey, 70_000]]), blockHeight: 499, blockHash: SOFT }]);
    config.finality = { [SOFT]: "soft" };
    try {
      assert.deepEqual(await sendsWith().sends.spendable(99), [{ asset: "", amount: "70000" }]);
    } finally {
      config.finality = {};
    }
  });

  test("a server that sends another transaction than the coin it listed sends nothing", async () => {
    const coin = paying("c3", [[RECEIVE_0.scriptPubkey, 100_000]]);
    fund([{ hex: coin, blockHeight: 400, blockHash: FINAL }]);
    // Another transaction paying the same address: it would spend a coin the server never listed.
    config.txHexOverrides = { [parseTx(coin).txid]: paying("c4", [[RECEIVE_0.scriptPubkey, 100_000]]) };
    const before = stub.broadcasts().length;
    try {
      await assert.rejects(sendsWith().sends.send(99, { outputs: [{ asset: "", amount: "1000", to: { address: PAY_TO } }] }), /isn't one it listed/);
      assert.equal(stub.broadcasts().length, before);
    } finally {
      config.txHexOverrides = undefined;
    }
  });

  test("a chain with no block for 5 minutes is reported stalled", async () => {
    fund([]);
    const tipTime = Math.floor(Date.now() / 1000) - wallet.FLUSH_STALL_SECONDS - 60;
    config.tipTime = tipTime;
    try {
      assert.equal((await pullPathWith().pullPath.reportedState(99)).stalledSince, tipTime);
    } finally {
      config.tipTime = undefined;
    }
  });

  test("a token output counts as the asset its creating transaction lists, and a result as its server's word", async () => {
    const tokens = async (tx) => flush.outputTokens(tx);
    // A transfer: 1,500 BROSEVELT units to RECEIVE_0 (output 0), beside an ECX payment.
    const transfer = paying("f1", [[RECEIVE_0.scriptPubkey, 0], [marker(0, [], [{ n: 0, asset: BROSEVELT, amount: 1_500 }]), 0], [RECEIVE_0.scriptPubkey, 9_000]]);
    // A ClaimLaunch (kind 23): its result output pays RECEIVE_1, whose token only the node knows.
    const claim = paying("f2", [[RECEIVE_1.scriptPubkey, 0], [marker(23, [...Buffer.alloc(32, 0xcd)], [{ n: 0 }]), 0]]);
    // An output of value 0 that no marker lists (a block producer's fee output, when the block has none).
    const unlisted = coinbase(320, [[RECEIVE_1.scriptPubkey, 0]]);
    fund([
      { hex: transfer, blockHeight: 300, blockHash: FINAL },
      { hex: claim, blockHeight: 310, blockHash: FINAL },
      { hex: unlisted, blockHeight: 320, blockHash: FINAL },
    ]);
    config.holdings = { [RECEIVE_1.address]: [{ ticker: "BROSEVELT", kind: "asset", asset_id: BROSEVELT, amount_units: "400" }] };
    try {
      const report = await pullPathWith({ tokens }).pullPath.reportedState(99);
      assert.deepEqual(report.balances, [
        { asset: BROSEVELT, amount: "1500" },
        { asset: "", amount: "9000" },
      ]);
      assert.deepEqual(report.unverified, [{ asset: BROSEVELT, amount: "400" }], "the result's token, as holdings has it");
      assert.ok(!stub.requests().some((p) => p.includes(RECEIVE_0.address) && p.endsWith("/holdings")), "an address with no result isn't asked");

      // Without the module's reading, a token output adds nothing, as before.
      const plain = await pullPathWith().pullPath.reportedState(99);
      assert.deepEqual(plain.balances, [{ asset: "", amount: "9000" }]);
      assert.equal(plain.unverified, undefined);
    } finally {
      config.holdings = undefined;
    }
  });

  test("a server that sends another transaction for a token output reports nothing", async () => {
    const transfer = paying("f3", [[RECEIVE_0.scriptPubkey, 0], [marker(0, [], [{ n: 0, asset: BROSEVELT, amount: 1 }]), 0]]);
    fund([{ hex: transfer, blockHeight: 300, blockHash: FINAL }]);
    config.txHexOverrides = { [parseTx(transfer).txid]: paying("f4", [[RECEIVE_0.scriptPubkey, 0], [marker(0, [], [{ n: 0, asset: BROSEVELT, amount: 10 ** 12 }]), 0]]) };
    try {
      await assert.rejects(pullPathWith({ tokens: async (tx) => flush.outputTokens(tx) }).pullPath.reportedState(99), /sent another transaction for/);
    } finally {
      config.txHexOverrides = undefined;
    }
  });

  test("an asset is named from its registration, checked against its ticker's hash", async () => {
    const memory = new Map();
    const store = { get: async (k) => memory.get(k), set: async (k, v) => void memory.set(k, v) };
    const assets = wallet.createAssets({ store, entryAssets: async () => module().chainEntry().networks.betanet.assets });
    const client = wallet.esploraClient(wallet.esploraConfig(module().chainEntry(), module().chainEntry().networks.betanet), (...args) => fetch(...args));
    fund([{ hex: LIVE_TXS[BROSEVELT_REGISTRATION], blockHeight: 604, blockHash: FINAL }]);
    config.flushAssets = { [BROSEVELT]: { asset: BROSEVELT, name: "BROSEVELT", decimals: 9, registered: 604, registration: BROSEVELT_REGISTRATION } };
    try {
      const stored = await assets.addByRegistration(module(), client, BROSEVELT);
      assert.deepEqual(stored, {
        id: BROSEVELT,
        name: "Theodore Brosevelt",
        ticker: "BROSEVELT",
        precision: 2, // the registration's, not the server's 9
        source: "registration",
        registration: BROSEVELT_REGISTRATION,
      });
      assert.equal((await assets.named(CHAIN)).find((a) => a.id === BROSEVELT)?.source, "registration");

      // The server names another asset's registration: refused by the module.
      const other = "617a6ad47771d6161d35023a90e7b5134ee6317c4f3d38475ec2cde540acb04f";
      config.flushAssets[other] = { ...config.flushAssets[BROSEVELT], asset: other };
      await assert.rejects(assets.addByRegistration(module(), client, other), new RegExp(`registers asset ${BROSEVELT}, not ${other}`));
      // Or a height the transaction isn't confirmed at.
      config.flushAssets[BROSEVELT].registered = 605;
      await assert.rejects(assets.addByRegistration(module(), client, BROSEVELT), /isn't confirmed at block 605/);
      await assert.rejects(assets.addByRegistration(module(), client, "ab".repeat(32)), /doesn't know asset/);
    } finally {
      config.flushAssets = undefined;
    }
  });

  test("unnamed assets are named from their registrations, with the logo their SetLogo carries", async () => {
    const memory = new Map();
    const store = { get: async (k) => memory.get(k), set: async (k, v) => void memory.set(k, v) };
    const assets = wallet.createAssets({ store, entryAssets: async () => module().chainEntry().networks.betanet.assets });
    const client = wallet.esploraClient(wallet.esploraConfig(module().chainEntry(), module().chainEntry().networks.betanet), (...args) => fetch(...args));
    fund([
      { hex: LIVE_TXS[BROSEVELT_REGISTRATION], blockHeight: 604, blockHash: FINAL },
      { hex: LIVE_TXS[BROSEVELT_LOGO], blockHeight: 8462, blockHash: FINAL },
    ]);
    const logo = { hash: "68472f4e69ed0aa96feac3e61f5a35bc119d34d33bce57af4a9d641a4ee730ed", mime: "image/jpeg", size: 15798, height: 8462, txid: BROSEVELT_LOGO };
    config.flushAssets = { [BROSEVELT]: { asset: BROSEVELT, registered: 604, registration: BROSEVELT_REGISTRATION, logo } };
    const unknown = "ab".repeat(32);
    try {
      const named = await assets.nameFromRegistrations(module(), client, [BROSEVELT, unknown]);
      const brosevelt = named.find((a) => a.id === BROSEVELT);
      assert.equal(brosevelt?.ticker, "BROSEVELT");
      assert.ok(brosevelt.logo.startsWith("data:image/jpeg;base64,/9j/"), "the JPEG its SetLogo carries");
      assert.equal(Buffer.from(brosevelt.logo.split(",")[1], "base64").length, 15_798);
      assert.equal(named.some((a) => a.id === unknown), false, "an asset the server doesn't know stays unknown");

      // A logo transaction not confirmed where the server says: the name stands, without a logo.
      await assets.remove(CHAIN, BROSEVELT);
      config.flushAssets[BROSEVELT].logo = { ...logo, height: 8463 };
      const again = (await assets.nameFromRegistrations(module(), client, [BROSEVELT])).find((a) => a.id === BROSEVELT);
      assert.deepEqual([again?.ticker, again?.logo], ["BROSEVELT", undefined]);
      // Or one that sets no logo (the registration itself).
      await assets.remove(CHAIN, BROSEVELT);
      config.flushAssets[BROSEVELT].logo = { ...logo, height: 604, txid: BROSEVELT_REGISTRATION };
      assert.equal((await assets.nameFromRegistrations(module(), client, [BROSEVELT])).find((a) => a.id === BROSEVELT)?.logo, undefined);
    } finally {
      config.flushAssets = undefined;
    }
  });

  test("a token Send spends only that asset's confirmed coins, lists its tokens, and pays the fee in ECX", async () => {
    const tokens = (seed, units) => paying(seed, [[RECEIVE_0.scriptPubkey, 0], [marker(0, [], [{ n: 0, asset: BROSEVELT, amount: units }]), 0]]);
    const confirmedTokens = tokens("a1", 5_000);
    const pendingTokens = tokens("a2", 700);
    const ecxCoin = paying("a3", [[RECEIVE_1.scriptPubkey, 100_000]]);
    fund([
      { hex: confirmedTokens, blockHeight: 400, blockHash: FINAL },
      { hex: pendingTokens, confirmed: false },
      { hex: ecxCoin, blockHeight: 401, blockHash: FINAL },
    ]);
    const { sends, prompts } = sendsWith();
    assert.deepEqual(
      (await sends.spendable(99)).sort((a, b) => a.asset.localeCompare(b.asset)),
      [
        { asset: "", amount: "100000" },
        { asset: BROSEVELT, amount: "5000" },
      ],
      "an unconfirmed token coin can't be spent",
    );

    const before = stub.broadcasts().length;
    await sends.send(99, { outputs: [{ asset: BROSEVELT, amount: "1200", to: { address: PAY_TO } }] });
    const { decoded } = prompts.at(-1).prompt;
    assert.equal(decoded.kind, "clear");
    assert.deepEqual(
      decoded.view.outputs.map(({ asset, amount, destination }) => [asset, amount, destination.yours]),
      [
        [BROSEVELT, "1200", false],
        [BROSEVELT, "3800", true],
        ["", decoded.view.outputs[2].amount, true],
      ],
    );
    assert.equal(stub.broadcasts().length, before + 1);
    const tx = parseTx(stub.broadcasts().at(-1));
    assert.deepEqual(tx.inputs.map((i) => i.txid), [parseTx(confirmedTokens).txid, parseTx(ecxCoin).txid]);
    assert.equal(flush.outputTokens(stub.broadcasts().at(-1)).outputs.length, 2, "the payment and the token change are listed");
  });

  test("a Deposit is credited by Flush's coinbase payout of its value, equal Deposits matched oldest first", async () => {
    // eCash's server: each Deposit confirmed twice (Flush's depositConfirmations is 2).
    const l1Config = { identityBlock: l1.chainEntry().networks.betanet.identityBlock, tipHeight: 1001, txStatuses: {} };
    const l1Stub = createEsploraStub(l1Config);
    const l1Url = await l1Stub.listen();
    try {
      const memory = new Map();
      const store = {
        list: async () => [...memory.values()].map((d) => structuredClone(d)),
        put: async (d) => void memory.set(d.txid, structuredClone(d)),
        remove: async (txid) => void memory.delete(txid),
      };
      const { deps } = pullPathWith();
      const at = (network, server) => ({ ...network, sidechainServer: { ...network.sidechainServer, url: server } });
      const deposits = wallet.createDeposits({
        ...deps,
        openSigningApproval: () => assert.fail("no approval"),
        esplora: (entry, network) => wallet.esploraClient(wallet.esploraConfig(entry, at(network, entry.slot === undefined ? l1Url : url)), (...args) => fetch(...args)),
        store,
        now: () => Date.now(),
      });
      const deposit = (n, value) => ({
        slot: 99,
        chainName: "Flush",
        txid: n.repeat(32),
        vout: 0,
        value: String(value),
        address: RECEIVE_0.address,
        asset: "",
        scriptPubkey: RECEIVE_0.scriptPubkey,
        createdAt: Number.parseInt(n, 16),
        slotHeight: 100,
      });
      const [d1, d2, d3] = [deposit("d1", 50_000), deposit("d2", 50_000), deposit("d3", 70_000)];
      for (const d of [d1, d2, d3]) {
        await store.put(d);
        l1Config.txStatuses[d.txid] = { confirmed: true, blockHeight: 1000, blockHash: "e0".repeat(32) };
      }

      // One payout of 50,000 so far, and an older one below the tip at the Deposits (a payment before them).
      const old = coinbase(90, [["", 0], [RECEIVE_0.scriptPubkey, 50_000]]);
      const first = coinbase(105, [["", 0], [RECEIVE_0.scriptPubkey, 50_000]]);
      fund([
        { hex: old, blockHeight: 90, blockHash: FINAL },
        { hex: first, blockHeight: 105, blockHash: FINAL },
      ]);
      let list = await deposits.list(99);
      const state = (d) => list.find((s) => s.txid === d.txid);
      assert.equal(state(d1).state, "credited", "the oldest Deposit takes the first payout");
      assert.deepEqual([state(d2).state, state(d2).paidBy, state(d2).claim], ["awaitingCredit", "chain", undefined]);
      assert.equal(state(d3).state, "awaitingCredit");
      assert.deepEqual(memory.get(d1.txid).credit, { txid: parseTx(first).txid, vout: 1 }, "kept, with its payout, while an equal Deposit waits");

      // The second payout comes: it's d2's, and both are forgotten once reported.
      const second = coinbase(110, [["", 0], [RECEIVE_1.scriptPubkey, 1], [RECEIVE_0.scriptPubkey, 50_000]]);
      fund([
        { hex: old, blockHeight: 90, blockHash: FINAL },
        { hex: first, blockHeight: 105, blockHash: FINAL },
        { hex: second, blockHeight: 110, blockHash: FINAL },
      ]);
      list = await deposits.list(99);
      assert.deepEqual([state(d1).state, state(d2).state, state(d3).state], ["credited", "credited", "awaitingCredit"]);
      assert.deepEqual([...memory.keys()], [d3.txid]);
    } finally {
      await l1Stub.close();
    }
  });

  test("the explorer's errors read as its own words", async () => {
    const client = wallet.esploraClient(wallet.esploraConfig(module().chainEntry(), module().chainEntry().networks.betanet), (...args) => fetch(...args));
    // `{"error": …}`, not the JSON itself.
    await assert.rejects(client.tx("ab".repeat(32)), /refused: No such mempool or blockchain transaction$/);
    await assert.rejects(client.blockHash(99_999), /refused: Failed to get block at height$/);
  });

  test("a refused broadcast names the node's reason, asked of testmempoolaccept", async () => {
    const client = wallet.esploraClient(wallet.esploraConfig(module().chainEntry(), module().chainEntry().networks.betanet), (...args) => fetch(...args));
    const tx = paying("c9", [[RECEIVE_0.scriptPubkey, 1_000]]);
    config.refuseBroadcast = 'sendrawtransaction RPC error: {"code":-26}';
    try {
      config.rejectReason = "min relay fee not met";
      await assert.rejects(client.broadcast(tx), /refused: sendrawtransaction RPC error: \{"code":-26\}: min relay fee not met$/);
      assert.ok(stub.requests().includes("POST /txs/test"));
      // No reason to add: the code alone, as the explorer said it.
      config.rejectReason = undefined;
      await assert.rejects(client.broadcast(tx), /refused: sendrawtransaction RPC error: \{"code":-26\}$/);
    } finally {
      config.refuseBroadcast = config.rejectReason = undefined;
    }
  });

  test("a broadcast allows a burn only when asked, in ECX", async () => {
    const client = wallet.esploraClient(wallet.esploraConfig(module().chainEntry(), module().chainEntry().networks.betanet), (...args) => fetch(...args));
    const before = stub.burnAllowances().length;
    await client.broadcast(paying("ca", [[RECEIVE_0.scriptPubkey, 1_000]]));
    // A DEX marker locking 10,000 sat: the node is told that much, and no more.
    await client.broadcast(paying("cb", [[RECEIVE_0.scriptPubkey, 1_000]]), "10000");
    await client.broadcast(paying("cc", [[RECEIVE_0.scriptPubkey, 1_000]]), "2100000000000000");
    assert.deepEqual(stub.burnAllowances().slice(before), [null, "0.0001", "21000000"]);
  });

  describe("a flush.markets trade (sendAction, docs/adr/0016)", () => {
    const link = (verb, params, exp = Math.floor(Date.now() / 1000) + 600) => `flush:${verb}?v=1&network=ecashbeta&exp=${exp}&${params}`;
    const buy = (ecx = "0.0001", minTokens = "0.044") => link("buy", `launch=FORK&asset=${FORK}&ecx=${ecx}&min_tokens=${minTokens}`);

    /** A confirmed 0.001 ECX coin, FORK known to the stub's node, its pool quoting `quote` FORK for what goes in. */
    function market(quote = 0.044482) {
      const coin = paying("d1", [[RECEIVE_1.scriptPubkey, 100_000]]);
      fund([
        { hex: coin, blockHeight: 400, blockHash: FINAL },
        { hex: TRADE.forkRegistration.hex, blockHeight: 7790, blockHash: FINAL },
      ]);
      config.flushAssets = { [FORK]: { asset: FORK, registered: 7790, registration: TRADE.forkRegistration.txid } };
      config.flushRpc = {
        getswapquote: () => ({ pools: [{ pool: FORK_POOL, curve: "launch", amount_out: quote }], best_pool: FORK_POOL }),
        getpool: ([id]) => (id === FORK_POOL ? TRADE.forkPool : undefined),
        getbitassetsinfo: { min_chn_payout: 0.00005, small_payout_height: 9000 },
      };
      config.flushRpcStatus = {};
    }

    after(() => {
      config.flushAssets = config.flushRpc = config.flushRpcStatus = undefined;
    });

    test("a launch buy is built, approved Clear, broadcast with its marker's ECX allowed, and its link won't run twice", async () => {
      market();
      const { sends, prompts, held, used } = sendsWith();
      const before = stub.broadcasts().length;
      const uri = buy();
      const result = await sends.trade(99, uri, { origin: DEX });

      assert.equal(prompts.length, 1);
      const { context, prompt } = prompts[0];
      assert.deepEqual(context, { origin: DEX, chain: CHAIN });
      assert.equal(prompt.decoded.kind, "clear");
      const { trade } = prompt.decoded.view;
      assert.deepEqual([trade.pool, trade.assetIn, trade.amountIn, trade.assetOut, trade.minOut, trade.warnings], [FORK_POOL, "", "10000", FORK, "44000", []]);
      assert.deepEqual([prompt.trade.verb, prompt.trade.quote, prompt.trade.assetOut.ticker, prompt.trade.assetOut.decimals], ["buy", "44482", "FORK", 6]);

      assert.equal(stub.broadcasts().length, before + 1);
      assert.equal(stub.burnAllowances().at(-1), "0.0001", "exactly the ECX its marker locks");
      const tx = parseTx(stub.broadcasts().at(-1));
      assert.equal(result.txid, tx.txid);
      assert.deepEqual([tx.outputs[0].value, tx.outputs[0].script], [0, RECEIVE_0.scriptPubkey], "the result, at the given-out address");
      assert.equal(tx.outputs[1].value, 10_000);
      assert.equal(held.length, 1);
      assert.equal(used.size, 1);

      await assert.rejects(sends.trade(99, uri, { origin: DEX }), (e) => e.code === -32602 && /already run/.test(e.message));
      assert.equal(prompts.length, 1, "refused before any window");
    });

    test("what the wallet won't build is refused, and never shown", async () => {
      const cases = [
        ["a floor the pool can't meet", () => market(0.04), buy(), -32602, /less than the link's floor/],
        ["a floor far below the quote", () => market(0.06), buy(), -32602, /more than 10% below/],
        ["an expired link", () => market(), link("buy", `launch=FORK&asset=${FORK}&ecx=0.0001&min_tokens=0.044`, 1_700_000_000), -32602, /expired/],
        ["another network's link", () => market(), buy().replace("ecashbeta", "ecash"), -32602, /network ecash/],
        ["an action the wallet doesn't build", () => market(), link("route", `pools=${FORK_POOL}`), 4200, /doesn't do Flush's "route"/],
        ["a node that can't quote", () => { market(); config.flushRpcStatus = { getswapquote: 503 }; }, buy(), -32001, /Busy/],
      ];
      for (const [what, setUp, uri, code, message] of cases) {
        setUp();
        const { sends, prompts } = sendsWith();
        const before = stub.broadcasts().length;
        // -32001 is the Provider's code for a server's failure: here, the error it comes from.
        const matches = (e) => (code === -32001 ? e instanceof wallet.SidechainServerError : e.code === code) && message.test(e.message);
        await assert.rejects(sends.trade(99, uri, { origin: DEX }), matches, what);
        assert.equal(stub.broadcasts().length, before, what);
        // The link's checks run before the window opens; the floor's, in the module, before it shows anything.
        assert.equal(prompts.length, 0, what);
      }
    });
  });
});

