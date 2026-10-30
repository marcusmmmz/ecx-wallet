// The pull path over each Server API, in node: the wallet's own TypeScript and the shipped
// elements.wasm against the stub servers, with a scripted approval window instead of a browser.
//
// - Standard Sidechain API (`ecx-v0`): no bundled chain speaks it in v0 (docs/adr/0002), so this is
//   where its client, the server-built Send and that Send's refusals are tested.
// - Esplora: the edge cases of reading a balance; pull-path.test covers it in the browsers.
//
// Slot 24's Chain Module is the shipped one with its Chain Entry's betanet server swapped for the
// stub under test. Payloads are the fixture PSETs from core/elements/tests/fixtures.rs.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { createEsploraStub } from "@ecx/stub-server/esplora";
import { parseElementsTx } from "@ecx/stub-server/elements-tx";
import { DIST_E2E, ROOT, importWallet, serveSidechainServer } from "../harness.mjs";

const PSETS = JSON.parse(await readFile(path.join(ROOT, "e2e", "fixtures", "elements-psets.json"), "utf8"));
const SLOT_24_STARTER = "buyer citizen congress doll secret merry denial law live wait pass drive";
const CHAIN = "ecash:betanet-s24";
const GENESIS = "a7754ce0debc40baddbd8c47e79d19209685f22c63edaaf8b69cf54116374d7f";
const RECEIVE_0 = "elements1qew44aehkjstjm56ng2rjrz57vwxh5g9su6dlpm";
const RECEIVE_1 = "elements1qnx6kczxpu35ypahwhqddx2pn6q0nuyaap97ygn";
const CHANGE_0 = "elements1q2n6usykz5ycrnfpup3hx0qa0manae07jgvvmuc";
const POLICY_ASSET = "5836dcc06130dcf6a65b6ac493813fd65559955283e44cc3f07966294eccb2c8";
const OTHER_ASSET = "1111111111111111111111111111111111111111111111111111111111111111";
// The `clear` fixture pays this foreign address 120 000 and sends 29 000 change back to us.
const FOREIGN_ADDRESS = "elements1qepkhlwlq2qjggg89d5quqx8z59vz9mr2h6j4pc";
const out = (amount, address = FOREIGN_ADDRESS, asset = POLICY_ASSET) => ({ asset, amount, to: { address } });

const wallet = await importWallet();
const elements = await wallet.loadChainModule(await readFile(path.join(DIST_E2E.chromium, "elements.wasm")));
const l1 = await wallet.loadChainModule(await readFile(path.join(DIST_E2E.chromium, "l1.wasm")));

const APP = "https://dex.example";

/**
 * The wallet's lock for a test: `steps` records each unlock asked for and each approval shown, in
 * order. The Starter is there only while unlocked.
 */
const lockState = (locked = false) => ({ unlocked: !locked, steps: [] });

/**
 * The pull path for Slot 24 with betanet's server set to `server`. `approve` answers each approval
 * window; `prompts` records what each one was opened for and shown.
 */
function pullPathWith(server, { approve = true, lock = lockState() } = {}) {
  const entry = structuredClone(elements.chainEntry());
  entry.networks.betanet.sidechainServer = server;
  const module = { ...elements, chainEntry: () => structuredClone(entry) };
  const prompts = [];
  const pullPath = wallet.createPullPath({
    supportedSlots: [24],
    chainModule: (slot) => (slot === 24 ? Promise.resolve(module) : undefined),
    openSigningApproval: (context) => approvalFor(context, { approve, lock, prompts }),
    isUnlocked: async () => lock.unlocked,
    starter: async () => starter(lock),
    l1Module: async () => l1,
    l1AccountKey: async () => assert.fail("Slot 24's pull path asked for the L1 Account Key"),
    now: () => Date.now(),
    sidechainServer: (chainEntry, network) => wallet.sidechainServer(chainEntry, network),
  });
  return { pullPath, prompts, module };
}

/** A scripted approval window: unlocking always succeeds; `approve` answers the review. */
function approvalFor(context, { approve, lock, prompts }) {
  return {
    unlock: async () => {
      lock.steps.push("unlock");
      lock.unlocked = true;
      return true;
    },
    confirm: async (prompt) => {
      lock.steps.push("confirm");
      prompts.push({ context, prompt });
      return approve;
    },
    close() {},
  };
}

async function starter(lock) {
  if (!lock.unlocked) throw new Error("The wallet is locked.");
  return SLOT_24_STARTER;
}

/**
 * The wallet's Send for Slot 24 with betanet's server set to `server`, holding spends in `held`
 * (an in-memory store). `prompts` records what each approval window was opened for and shown.
 */
function sendsWith(server, { approve = true, held = [], cache = new Map(), lock = lockState() } = {}) {
  const { pullPath, prompts, module } = pullPathWith(server, { approve, lock });
  const sends = wallet.createSends({
    chainModule: (slot) => (slot === 24 ? Promise.resolve(module) : undefined),
    l1Module: async () => l1,
    starter: async () => starter(lock),
    l1AccountKey: async () => assert.fail("Slot 24's Send asked for the L1 Account Key"),
    pullPath,
    esplora: (entry, network) =>
      wallet.esploraClient({ url: network.sidechainServer.url, identityBlock: network.identityBlock, chainName: entry.name }, (...args) => fetch(...args)),
    openSigningApproval: (context) => approvalFor(context, { approve, lock, prompts }),
    isUnlocked: async () => lock.unlocked,
    held: {
      list: async () => [...held],
      put: async (h) => void held.push(h),
      remove: async (txid) => void held.splice(held.findIndex((h) => h.txid === txid), 1),
    },
    cache: { get: async (k) => cache.get(k), set: async (k, v) => void cache.set(k, v) },
    now: () => 1792000000000,
  });
  return { sends, prompts, held };
}

/** What the Standard Sidechain API stub reports per address (read on every request). */
const STANDARD_STATE = {
  [RECEIVE_0]: {
    balances: [
      { asset: POLICY_ASSET, amount: "150000" },
      { asset: OTHER_ASSET, amount: "7" },
    ],
    unconfirmed: [{ asset: POLICY_ASSET, amount: "900" }],
    history: [
      { txid: "ab".repeat(32), amounts: [{ asset: POLICY_ASSET, amount: "-120300" }], confirmed: false, trusted: true },
      { txid: "aa".repeat(32), amounts: [{ asset: POLICY_ASSET, amount: "150000" }], confirmed: true, time: 1792000000 },
    ],
  },
};

describe("Standard Sidechain API", () => {
  let stub;
  before(async () => {
    stub = await serveSidechainServer({
      state: STANDARD_STATE,
      // Each amount picks a fixture; a real server builds the transfer it's asked for.
      transfers: [
        { outputs: [out("120000")], payload: PSETS.clear.payload },
        { outputs: [out("2")], payload: PSETS.blind.payload },
        { outputs: [out("3")], payload: PSETS.wrongGenesis.payload },
        { outputs: [out("4")], payload: PSETS.clear.payload, expiresIn: -60 },
        { outputs: [out("5")], payload: PSETS.confidentialInput.payload },
        { outputs: [out("6")], payload: PSETS.confidentialOutput.payload },
        // Asked for 7, it pays 120 000: not the transfer asked for.
        { outputs: [out("7")], payload: PSETS.clear.payload },
      ],
    });
  });
  after(() => stub?.close());

  const server = () => ({ api: "ecx-v0", url: stub.url });
  const send = (pullPath, amount) => pullPath.send(24, { outputs: [out(amount)] });

  test("the reported state comes after registering the descriptor and the receive addresses", async () => {
    const report = await pullPathWith(server()).pullPath.reportedState(24);
    assert.equal(report.server, stub.url);
    assert.deepEqual(report.balances, [
      { asset: POLICY_ASSET, amount: "150000" },
      { asset: OTHER_ASSET, amount: "7" },
    ]);
    assert.deepEqual(report.unconfirmed, [{ asset: POLICY_ASSET, amount: "900" }]);

    const registration = stub.registrations().at(-1);
    assert.equal(registration.chain, CHAIN);
    assert.match(registration.descriptor, /^elwpkh\(\[3b27f87d\/84h\/1h\/0h\]tpub/);
    assert.equal(registration.addresses.length, wallet.WATCHED_RECEIVE_ADDRESSES);
    assert.deepEqual(registration.addresses.slice(0, 2).map((a) => a.address), [RECEIVE_0, RECEIVE_1]);
    assert.ok(!registration.addresses.some((a) => a.address === CHANGE_0), "the server derives change from the descriptor");
  });

  test("history (draft 2) is the state's `history`: signed net amounts, when confirmed, and whether a pending one is trusted", async () => {
    const history = await pullPathWith(server()).pullPath.history(24);
    assert.equal(history.server, stub.url);
    assert.equal(history.partial, false);
    assert.deepEqual(history.entries, [
      { txid: "ab".repeat(32), amounts: [{ asset: POLICY_ASSET, amount: "-120300" }], confirmed: false, trusted: true },
      { txid: "aa".repeat(32), amounts: [{ asset: POLICY_ASSET, amount: "150000" }], confirmed: true, time: 1792000000 },
    ]);
  });

  test("a malformed history entry is refused", async () => {
    const state = STANDARD_STATE[RECEIVE_0];
    const { history } = state;
    const valid = { txid: "aa".repeat(32), amounts: [{ asset: POLICY_ASSET, amount: "150000" }], confirmed: true, time: 1792000000 };
    const malformed = [
      { ...valid, txid: "aa" },
      { ...valid, amounts: [{ asset: POLICY_ASSET, amount: "+150000" }] },
      { ...valid, amounts: [{ asset: "policy", amount: "150000" }] },
      { ...valid, confirmed: "yes" },
      { ...valid, time: "yesterday" },
      { txid: "ab".repeat(32), amounts: [], confirmed: false },
    ];
    try {
      for (const entry of malformed) {
        state.history = [entry];
        await assert.rejects(
          pullPathWith(server()).pullPath.history(24),
          (e) => e instanceof wallet.SidechainServerError && /malformed history/.test(e.message),
          JSON.stringify(entry),
        );
      }
      state.history = "none";
      await assert.rejects(pullPathWith(server()).pullPath.history(24), /malformed history/);
    } finally {
      state.history = history;
    }
  });

  test("a server that leaves `unconfirmed` out gives the report nothing unconfirmed", async () => {
    const state = STANDARD_STATE[RECEIVE_0];
    const { unconfirmed } = state;
    delete state.unconfirmed;
    try {
      assert.deepEqual((await pullPathWith(server()).pullPath.reportedState(24)).unconfirmed, []);
    } finally {
      state.unconfirmed = unconfirmed;
    }
  });

  test("a malformed unconfirmed amount is refused like a malformed balance", async () => {
    const state = STANDARD_STATE[RECEIVE_0];
    const { unconfirmed } = state;
    state.unconfirmed = [{ asset: POLICY_ASSET, amount: "-900" }];
    try {
      await assert.rejects(pullPathWith(server()).pullPath.reportedState(24), (e) => e instanceof wallet.SidechainServerError && /malformed state/.test(e.message));
    } finally {
      state.unconfirmed = unconfirmed;
    }
  });

  test("Send: the server builds the transfer, the approval names the server, and the signed payload goes back", async () => {
    const { pullPath, prompts } = pullPathWith(server());
    const result = await send(pullPath, "120000");
    assert.equal(result.accepted, true);
    assert.equal(result.server, stub.url);
    assert.equal(prompts.length, 1);
    assert.deepEqual(prompts[0].context, { origin: stub.url, chain: CHAIN });
    assert.equal(prompts[0].prompt.decoded.kind, "clear");
    assert.equal(prompts[0].prompt.decoded.view.outputs[0].destination.address, FOREIGN_ADDRESS);
    const submitted = stub.submissions().at(-1);
    assert.equal(submitted.payload, PSETS.clear.signed, "the same PSET, signed on our input only");
  });

  test("Send: rejecting the approval submits nothing", async () => {
    const before = stub.submissions().length;
    await assert.rejects(send(pullPathWith(server(), { approve: false }).pullPath, "120000"), /rejected/i);
    assert.equal(stub.submissions().length, before);
  });

  test("Send: a server-built request the Decoder can't fully explain is refused without an approval", async () => {
    const before = stub.submissions().length;
    const { pullPath, prompts } = pullPathWith(server());
    await assert.rejects(send(pullPath, "2"), (e) => e instanceof wallet.SidechainServerError && /Clear Signed/.test(e.message));
    assert.equal(prompts.length, 0, "never shown, so never Blind-signed");
    assert.equal(stub.submissions().length, before);
  });

  test("Send: a server-built transfer that isn't the one asked for is refused without an approval", async () => {
    const before = stub.submissions().length;
    const { pullPath, prompts } = pullPathWith(server());
    await assert.rejects(send(pullPath, "7"), (e) => e instanceof wallet.SidechainServerError && /isn't the one asked for\. Nothing was sent\.$/.test(e.message));
    assert.equal(prompts.length, 0);
    assert.equal(stub.submissions().length, before);
  });

  test("the wallet's Send hands a Slot whose server speaks `/v1` to the server", async () => {
    const before = stub.submissions().length;
    const result = await sendsWith(server()).sends.send(24, { outputs: [out("120000")] });
    assert.equal(result.server, stub.url);
    assert.equal(stub.submissions().length, before + 1);
  });

  test("an app's Send: the approval names the app, and while locked the same window unlocks before the server builds", async () => {
    const before = stub.submissions().length;
    const lock = lockState(true);
    const { sends, prompts } = sendsWith(server(), { lock });
    const result = await sends.send(24, { outputs: [out("120000")] }, { origin: APP });
    assert.equal(result.accepted, true);
    assert.deepEqual(lock.steps, ["unlock", "confirm"]);
    assert.deepEqual(prompts[0].context, { origin: APP, chain: CHAIN });
    assert.equal(prompts[0].prompt.origin, APP);
    assert.equal(stub.submissions().length, before + 1);
  });

  for (const [what, amount, message] of [
    ["a wrong genesis", "3", /genesis/i],
    ["an expired expiresAt", "4", /expired/i],
    ["a confidential input", "5", /confidential/i],
    ["a confidential output", "6", /confidential/i],
  ]) {
    test(`Send: a server-built request with ${what} is refused as the server's error`, async () => {
      const before = stub.submissions().length;
      const { pullPath, prompts } = pullPathWith(server());
      await assert.rejects(send(pullPath, amount), (e) => e instanceof wallet.SidechainServerError && message.test(e.message));
      assert.equal(prompts.length, 0);
      assert.equal(stub.submissions().length, before);
    });
  }
});

describe("Esplora", () => {
  const config = { identityBlock: { height: 0, hash: GENESIS }, utxos: {} };
  let stub;
  let url;
  before(async () => {
    stub = createEsploraStub(config);
    url = await stub.listen();
  });
  after(() => stub?.close());

  const reported = () => pullPathWith({ api: "esplora", url }).pullPath.reportedState(24);

  test("the balance is the confirmed explicit outputs of the receive and change addresses, per asset, and the unconfirmed ones are summed apart", async () => {
    config.utxos = {
      [RECEIVE_0]: [
        { txid: "a0".repeat(32), vout: 0, value: 150000, asset: POLICY_ASSET, confirmed: true },
        { txid: "a1".repeat(32), vout: 0, value: 5000, asset: POLICY_ASSET, confirmed: false },
      ],
      [RECEIVE_1]: [{ txid: "a2".repeat(32), vout: 1, value: 7, asset: OTHER_ASSET, confirmed: true }],
      [CHANGE_0]: [
        { txid: "a3".repeat(32), vout: 1, value: 29000, asset: POLICY_ASSET, confirmed: true },
        { txid: "a4".repeat(32), vout: 2, valuecommitment: `08${"11".repeat(32)}`, assetcommitment: `0a${"22".repeat(32)}`, confirmed: true },
        { txid: "a5".repeat(32), vout: 0, valuecommitment: `09${"33".repeat(32)}`, assetcommitment: `0b${"44".repeat(32)}`, confirmed: false },
      ],
    };
    const report = await reported();
    assert.equal(report.server, url);
    assert.deepEqual(report.balances, [
      { asset: POLICY_ASSET, amount: "179000" },
      { asset: OTHER_ASSET, amount: "7" },
    ]);
    assert.deepEqual(report.unconfirmed, [{ asset: POLICY_ASSET, amount: "5000" }], "the confidential unconfirmed output isn't counted");
    const queried = stub.requests().filter((p) => p.endsWith("/utxo")).length;
    assert.equal(queried, wallet.WATCHED_RECEIVE_ADDRESSES + wallet.WATCHED_CHANGE_ADDRESSES);
  });

  test("a server on another chain is a hard error, and nothing else is asked of it", async () => {
    config.identityBlock = { height: 0, hash: "00".repeat(32) };
    const before = stub.requests().length;
    try {
      await assert.rejects(reported(), (e) => e instanceof wallet.SidechainServerError && /another chain/.test(e.message));
      assert.deepEqual(stub.requests().slice(before), ["/block-height/0"]);
    } finally {
      config.identityBlock = { height: 0, hash: GENESIS };
    }
  });

  test("an answer that isn't a list of outputs is refused", async () => {
    config.utxos = { [RECEIVE_0]: [{ txid: "a0".repeat(32), vout: 0, value: "150000", asset: POLICY_ASSET, confirmed: true }] };
    await assert.rejects(reported(), /malformed output/);
  });

  test("an unreachable server says so", async () => {
    const { pullPath } = pullPathWith({ api: "esplora", url: "http://127.0.0.1:9" });
    await assert.rejects(pullPath.reportedState(24), /Couldn't reach the Sidechain Server at http:\/\/127\.0\.0\.1:9/);
  });

  test("the pull path's own Send refuses: over Esplora the wallet builds", async () => {
    const { pullPath, prompts } = pullPathWith({ api: "esplora", url });
    await assert.rejects(pullPath.send(24, { outputs: [out("1000")] }), (e) => e instanceof wallet.SidechainServerError && /doesn't build transfers/.test(e.message));
    assert.equal(prompts.length, 0);
  });
});

describe("Send over Esplora", () => {
  const account = elements.deriveAccount(SLOT_24_STARTER, { receive: wallet.WATCHED_RECEIVE_ADDRESSES, change: wallet.WATCHED_CHANGE_ADDRESSES });
  const config = { identityBlock: { height: 0, hash: GENESIS }, elements: true, tipHeight: 100, feeEstimates: {}, utxos: {} };
  let stub;
  let url;
  before(async () => {
    stub = createEsploraStub(config);
    url = await stub.listen();
  });
  after(() => stub?.close());
  const esplora = () => ({ api: "esplora", url });
  const utxo = (n, value, { confirmed = true, asset = POLICY_ASSET, vout = 0 } = {}) => ({ txid: n.repeat(32), vout, value, asset, confirmed });
  /** Each output of the Clear View the user was shown, as (amount, address, yours). */
  const shown = (prompt) => prompt.decoded.view.outputs.map((o) => [o.amount, o.destination.address, o.destination.yours]);

  test("the module builds from the account's coins, the approval names the wallet, and the signed transaction is broadcast", async () => {
    config.utxos = { [RECEIVE_0]: [utxo("a0", 150000)] };
    config.addressTxCounts = { [CHANGE_0]: 1 };
    const { sends, prompts, held } = sendsWith(esplora());
    const before = stub.broadcasts().length;
    const result = await sends.send(24, { outputs: [out("120000"), out("1000", RECEIVE_1)] });

    assert.equal(prompts.length, 1);
    assert.deepEqual(prompts[0].context, { origin: "This wallet (Send on Elements+)", chain: CHAIN });
    const fee = BigInt(prompts[0].prompt.decoded.view.fee.amount);
    const change = account.change[1].address;
    assert.deepEqual(shown(prompts[0].prompt), [
      ["120000", FOREIGN_ADDRESS, false],
      ["1000", RECEIVE_1, false], // a payment carries no derivation, so it doesn't show as yours
      [String(150000n - 121000n - fee), change, true],
    ], "change to the first unused change address");

    assert.equal(stub.broadcasts().length, before + 1);
    const tx = parseElementsTx(stub.broadcasts().at(-1));
    assert.deepEqual(result, { server: url, accepted: true, txid: tx.txid });
    assert.deepEqual(tx.inputs, [{ txid: "a0".repeat(32), vout: 0 }]);
    assert.deepEqual(held, [{ slot: 24, txid: tx.txid, spent: [{ txid: "a0".repeat(32), vout: 0 }], tipHeight: 100 }]);
    config.addressTxCounts = {};
  });

  test("with every change address used, change goes to the last one", async () => {
    config.utxos = { [RECEIVE_0]: [utxo("a0", 150000)] };
    config.addressTxCounts = Object.fromEntries(account.change.map((a) => [a.address, 1]));
    try {
      const { sends, prompts } = sendsWith(esplora());
      await sends.send(24, { outputs: [out("1000")] });
      assert.equal(shown(prompts[0].prompt)[1][1], account.change.at(-1).address);
    } finally {
      config.addressTxCounts = {};
    }
  });

  test("a coin a broadcast Send spent is held until it confirms, or until the server forgot it 6 blocks ago", async () => {
    config.utxos = { [RECEIVE_0]: [utxo("a0", 150000)] };
    const first = sendsWith(esplora());
    const { txid } = await first.sends.send(24, { outputs: [out("1000")] });
    const again = () => sendsWith(esplora(), { held: first.held }).sends;
    // The stub still lists the coin, as a server that hasn't seen the spend would.
    assert.deepEqual(await again().spendable(24), []);
    await assert.rejects(again().send(24, { outputs: [out("1000")] }), /Not enough ECX/);

    delete config.txStatuses[txid];
    config.tipHeight = 105;
    assert.deepEqual(await again().spendable(24), [], "forgotten, but only 5 blocks ago");
    config.tipHeight = 106;
    assert.deepEqual(await again().spendable(24), [{ asset: POLICY_ASSET, amount: "150000" }]);
    assert.deepEqual(first.held, []);

    const { txid: second } = await again().send(24, { outputs: [out("1000")] });
    config.txStatuses[second] = { confirmed: true, blockHeight: 107 };
    await again().spendable(24);
    assert.deepEqual(first.held, [], "released once confirmed");
    config.tipHeight = 100;
  });

  test("unconfirmed coins are spent only from the wallet's own trusted transactions", async () => {
    const ours = account.receive[0].scriptPubkey;
    const pending = (txid, prevout) => ({
      txid,
      vin: [{ txid: "a0".repeat(32), vout: 0, prevout }],
      vout: [{ scriptpubkey: ours, value: 4000, asset: POLICY_ASSET }],
      status: { confirmed: false },
    });
    config.utxos = { [RECEIVE_0]: [utxo("b1", 4000, { confirmed: false }), utxo("b2", 3000, { confirmed: false })] };
    config.addressTxs = {
      [RECEIVE_0]: [
        pending("b1".repeat(32), { scriptpubkey: ours, value: 5000, asset: POLICY_ASSET }),
        pending("b2".repeat(32), { scriptpubkey: "0014" + "77".repeat(20), value: 3000, asset: POLICY_ASSET }),
      ],
    };
    try {
      assert.deepEqual(await sendsWith(esplora()).sends.spendable(24), [{ asset: POLICY_ASSET, amount: "4000" }]);
    } finally {
      config.addressTxs = undefined;
    }
  });

  test("the history reads older pages past Esplora's first 25 confirmed transactions", async () => {
    const ours = account.receive[0].scriptPubkey;
    const confirmedTx = (i) => ({
      txid: i.toString(16).padStart(64, "c"),
      vin: [],
      vout: [{ scriptpubkey: ours, value: 1, asset: POLICY_ASSET }],
      status: { confirmed: true, block_height: 100 - i, block_hash: "00".repeat(32), block_time: 1792000000 },
    });
    config.addressTxs = { [RECEIVE_0]: Array.from({ length: 60 }, (_, i) => confirmedTx(i)) };
    try {
      const history = await pullPathWith(esplora()).pullPath.history(24);
      assert.equal(history.entries.length, 60);
      assert.equal(history.partial, false);
    } finally {
      config.addressTxs = undefined;
    }
  });

  test("a partial history spends confirmed coins only: an unlisted parent could pass for trusted", async () => {
    const ours = account.receive[0].scriptPubkey;
    const confirmedTx = (i) => ({
      txid: i.toString(16).padStart(64, "c"),
      vin: [],
      vout: [{ scriptpubkey: ours, value: 1, asset: POLICY_ASSET }],
      status: { confirmed: true, block_height: 1, block_hash: "00".repeat(32), block_time: 1792000000 },
    });
    const trustedPending = {
      txid: "b1".repeat(32),
      vin: [{ txid: "a0".repeat(32), vout: 0, prevout: { scriptpubkey: ours, value: 5000, asset: POLICY_ASSET } }],
      vout: [{ scriptpubkey: ours, value: 4000, asset: POLICY_ASSET }],
      status: { confirmed: false },
    };
    config.utxos = { [RECEIVE_0]: [utxo("a0", 150000), utxo("b1", 4000, { confirmed: false })] };
    // Full pages past the last one the history reads, so older ones may be missing.
    const confirmed = 25 * (wallet.HISTORY_PAGES + 1) + 1;
    config.addressTxs = { [RECEIVE_0]: [trustedPending, ...Array.from({ length: confirmed }, (_, i) => confirmedTx(i))] };
    try {
      assert.deepEqual(await sendsWith(esplora()).sends.spendable(24), [{ asset: POLICY_ASSET, amount: "150000" }]);
    } finally {
      config.addressTxs = undefined;
    }
  });

  test("a Slot whose module doesn't build transfers has no Send over Esplora, but does over `/v1`", async () => {
    const entry = structuredClone(elements.chainEntry());
    const withoutBuild = (api) => {
      entry.networks.betanet.sidechainServer = { api, url };
      const declared = elements.declare();
      return {
        ...elements,
        chainEntry: () => structuredClone(entry),
        declare: () => ({ ...declared, capabilities: declared.capabilities.filter((c) => c !== "buildTransfer") }),
      };
    };
    assert.equal(wallet.describeChain(withoutBuild("esplora")).sends, false);
    assert.equal(wallet.describeChain(withoutBuild("ecx-v0")).sends, true);
    assert.equal(wallet.describeChain(elements).sends, true, "the shipped module over Esplora");

    config.utxos = { [RECEIVE_0]: [utxo("a0", 150000)] };
    const module = withoutBuild("esplora");
    const sends = wallet.createSends({
      chainModule: async () => module,
      l1Module: async () => l1,
      starter: async () => SLOT_24_STARTER,
      l1AccountKey: async () => assert.fail(),
      pullPath: pullPathWith(esplora()).pullPath,
      esplora: () => assert.fail("asked its server"),
      openSigningApproval: () => assert.fail("opened an approval"),
      isUnlocked: async () => true,
      held: { list: async () => [], put: async () => {}, remove: async () => {} },
      now: () => 0,
    });
    await assert.rejects(sends.send(24, { outputs: [out("1000")] }), /can't send on Elements\+: its Chain Module doesn't build transfers/);
  });

  test("a refused broadcast says nothing was sent, holds nothing, and is kept for the Activity feed until a Send goes through", async () => {
    config.utxos = { [RECEIVE_0]: [utxo("a0", 150000)] };
    config.refuseBroadcast = "bad-txns-inputs-missingorspent";
    const cache = new Map();
    const held = [];
    try {
      const { sends } = sendsWith(esplora(), { cache, held });
      await assert.rejects(sends.send(24, { outputs: [out("1000")] }), /bad-txns-inputs-missingorspent Nothing was sent\.$/);
      assert.deepEqual(held, []);
      // The popup that asked closed when the approval window opened: the reason must outlive it.
      const refused = await sends.refused(24);
      assert.deepEqual(refused.outputs, [out("1000")]);
      assert.match(refused.reason, /Nothing was sent\.$/);
    } finally {
      config.refuseBroadcast = undefined;
    }
    const { sends } = sendsWith(esplora(), { cache, held });
    await sends.send(24, { outputs: [out("1000")] });
    assert.equal(await sends.refused(24), undefined, "cleared by the next Send that goes through");
  });

  test("the module's refusals reach the user before any approval", async () => {
    config.utxos = { [RECEIVE_0]: [utxo("a0", 150000)] };
    const { sends, prompts } = sendsWith(esplora());
    await assert.rejects(sends.send(24, { outputs: [out("13")] }), /below the smallest amount Elements relays/);
    await assert.rejects(sends.send(24, { outputs: [out("200000")] }), /^ProviderRpcError: Not enough ECX|Not enough ECX/);
    await assert.rejects(sends.send(24, { outputs: [out("1000", "")] }), /Enter a destination address/);
    await assert.rejects(sends.send(24, { outputs: [] }), /Add at least one recipient/);
    assert.equal(prompts.length, 0);
  });

  test("a server answering another txid gets an error, but the coins its broadcast spent stay held", async () => {
    config.utxos = { [RECEIVE_0]: [utxo("a0", 150000)] };
    config.broadcastTxid = "ee".repeat(32);
    const cache = new Map();
    const { sends, held } = sendsWith(esplora(), { cache });
    try {
      await assert.rejects(sends.send(24, { outputs: [out("1000")] }), new RegExp(`reported txid ${"ee".repeat(32)} for transaction`));
    } finally {
      config.broadcastTxid = undefined;
    }
    const sent = parseElementsTx(stub.broadcasts().at(-1)).txid;
    assert.deepEqual(held.map((h) => [h.txid, h.spent]), [[sent, [{ txid: "a0".repeat(32), vout: 0 }]]]);
    assert.equal(await sends.refused(24), undefined, "it went out: not shown as a failed Send");
  });

  test("an app's Send: the approval names the app, and while locked unlocks before the wallet builds", async () => {
    config.utxos = { [RECEIVE_0]: [utxo("a0", 150000)] };
    const lock = lockState(true);
    const { sends, prompts, held } = sendsWith(esplora(), { lock });
    const result = await sends.send(24, { outputs: [out("1000")] }, { origin: APP });
    assert.deepEqual(lock.steps, ["unlock", "confirm"]);
    assert.deepEqual(prompts[0].context, { origin: APP, chain: CHAIN });
    assert.equal(prompts[0].prompt.origin, APP);
    assert.equal(result.txid, parseElementsTx(stub.broadcasts().at(-1)).txid);
    assert.deepEqual(held.map((h) => h.txid), [result.txid], "its coins are held like the wallet's own Send's");
  });

  test("an app's Send that fails after approval goes back to the app, not to the Activity feed", async () => {
    config.utxos = { [RECEIVE_0]: [utxo("a0", 150000)] };
    config.refuseBroadcast = "bad-txns-inputs-missingorspent";
    try {
      const { sends } = sendsWith(esplora());
      await assert.rejects(sends.send(24, { outputs: [out("1000")] }, { origin: APP }), /Nothing was sent\.$/);
      assert.equal(await sends.refused(24), undefined);
    } finally {
      config.refuseBroadcast = undefined;
    }
  });

  test("two Sends at once go one after the other, so the second can't pick the first's coins", async () => {
    config.utxos = { [RECEIVE_0]: [utxo("a0", 150000)] };
    const before = stub.broadcasts().length;
    const { sends } = sendsWith(esplora());
    const [first, second] = await Promise.allSettled([
      sends.send(24, { outputs: [out("1000")] }, { origin: APP }),
      sends.send(24, { outputs: [out("2000")] }),
    ]);
    assert.equal(first.status, "fulfilled");
    assert.equal(second.status, "rejected");
    assert.match(second.reason.message, /Not enough ECX/);
    assert.equal(stub.broadcasts().length, before + 1);
  });

  test("an output to anything but an address is refused, naming what is supported", async () => {
    const { sends, prompts } = sendsWith(esplora());
    await assert.rejects(
      sends.send(24, { outputs: [{ asset: POLICY_ASSET, amount: "1000", to: { script: "6a" } }] }, { origin: APP }),
      (e) => e.code === -32602 && /can only pay an address \(`to: \{ address \}`\), not `script`/.test(e.message),
    );
    assert.equal(prompts.length, 0);
  });

  test("rejecting the approval broadcasts nothing, and isn't kept as a failure", async () => {
    config.utxos = { [RECEIVE_0]: [utxo("a0", 150000)] };
    const before = stub.broadcasts().length;
    const { sends } = sendsWith(esplora(), { approve: false });
    await assert.rejects(sends.send(24, { outputs: [out("1000")] }), /rejected/i);
    assert.equal(stub.broadcasts().length, before);
    assert.equal(await sends.refused(24), undefined);
  });
});

test("a Chain Entry naming a Server API the wallet doesn't speak is refused", async () => {
  const { pullPath } = pullPathWith({ api: "electrum", url: "http://127.0.0.1:9" });
  await assert.rejects(pullPath.reportedState(24), /Server API this wallet doesn't speak: electrum/);
});
