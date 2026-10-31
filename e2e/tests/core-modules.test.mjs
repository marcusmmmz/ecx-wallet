// The core modules: each `.wasm` in the extension builds, loaded through the wallet's hand-written
// glue exactly as the background loads it (no browser needed). The shipped build is mainnet's; the
// modules' betanet behaviour is checked in the e2e build, whose modules differ only in their servers.
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { DIST, DIST_E2E, ROOT, importWallet } from "../harness.mjs";

const ABANDON = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

test("every shipped .wasm imports nothing but memory", async () => {
  // The shipped build is mainnet's: eCash and Flush, no Elements+ (docs/adr/0019). The e2e build,
  // betanet's, adds elements.wasm, so its modules are checked too.
  const wasmIn = async (dir) => (await readdir(dir)).filter((f) => f.endsWith(".wasm")).sort();
  const shipped = await wasmIn(DIST.chromium);
  assert.deepEqual(shipped, ["flush.wasm", "l1.wasm", "vault.wasm"], "the mainnet build's modules");
  const e2e = await wasmIn(DIST_E2E.chromium);
  assert.deepEqual(e2e, ["elements.wasm", "flush.wasm", "l1.wasm", "vault.wasm"], "the betanet build's modules");
  const files = [...shipped.map((f) => path.join(DIST.chromium, f)), ...e2e.map((f) => path.join(DIST_E2E.chromium, f))];
  for (const file of files) {
    const module = new WebAssembly.Module(await readFile(file));
    const imports = WebAssembly.Module.imports(module).filter((i) => i.kind !== "memory");
    assert.deepEqual(imports, [], `${path.relative(ROOT, file)} imports more than memory`);
  }
});

test("the shipped Vault yields the BitWindow Slot 24 Starters, with and without a passphrase", async () => {
  const { loadVaultModule } = await importWallet();
  const vault = await loadVaultModule(await readFile(path.join(DIST_E2E.chromium, "vault.wasm")));
  assert.equal(vault.starter(ABANDON, "", 24), "buyer citizen congress doll secret merry denial law live wait pass drive");
  assert.equal(vault.starter(ABANDON, "TREZOR", 24), "raw sister combine impact penalty improve soap power tomato topic frog flip");
});

test("the shipped Vault creates from caller entropy, checks imports and stretches passwords", async () => {
  const { loadVaultModule } = await importWallet();
  const vault = await loadVaultModule(await readFile(path.join(DIST_E2E.chromium, "vault.wasm")));
  assert.equal(vault.masterMnemonicFromEntropy(new Uint8Array(16)), ABANDON);
  assert.equal(vault.canonicalMnemonic(`  ${ABANDON.toUpperCase()} `), ABANDON);
  assert.throws(() => vault.canonicalMnemonic("abandon abandon"), /word count|invalid/i);
  const key = vault.stretchPassword(
    new TextEncoder().encode("password"),
    new TextEncoder().encode("somesaltsomesalt"),
    { mKib: 65536, t: 3, p: 1 },
  );
  assert.equal(Buffer.from(key).toString("hex"), "7664ad4ba1a3c999fcdd0991ffc2270f78302d2383233db5e7befc85d1bb1819");
});

// The Slot 24 Starter of ABANDON (no passphrase); address fixtures as in core/elements/tests.
const SLOT_24_STARTER = "buyer citizen congress doll secret merry denial law live wait pass drive";

test("the shipped Elements Chain Module declares its binding and bundles Slot 24's Chain Entry", async () => {
  const { loadChainModule } = await importWallet();
  const elements = await loadChainModule(await readFile(path.join(DIST_E2E.chromium, "elements.wasm")));
  assert.deepEqual(elements.declare(), {
    binding: { chain: "ecash:betanet-s24", format: "pset", payloadVersions: ["1"] },
    capabilities: ["depositDestination", "buildTransfer", "assetContract"],
  });
  const entry = elements.chainEntry();
  assert.equal(entry.networks.betanet.slot, 24);
  assert.equal(entry.networks.betanet.chain, "ecash:betanet-s24");
  assert.equal(entry.networks.betanet.parent, "ecash:betanet");
  assert.equal(entry.networks.betanet.params.genesisHash, "a7754ce0debc40baddbd8c47e79d19209685f22c63edaaf8b69cf54116374d7f");
  assert.equal(entry.networks.betanet.params.policyAsset, "5836dcc06130dcf6a65b6ac493813fd65559955283e44cc3f07966294eccb2c8");
});

test("the shipped Elements Chain Module derives the Slot 24 receive and change addresses from the Starter", async () => {
  const { loadChainModule } = await importWallet();
  const elements = await loadChainModule(await readFile(path.join(DIST_E2E.chromium, "elements.wasm")));
  const account = elements.deriveAccount(SLOT_24_STARTER, { receive: 2 });
  assert.deepEqual(account.receive.map((a) => a.address), [
    "elements1qew44aehkjstjm56ng2rjrz57vwxh5g9su6dlpm",
    "elements1qnx6kczxpu35ypahwhqddx2pn6q0nuyaap97ygn",
  ]);
  assert.deepEqual(account.change, [], "no change addresses unless asked");
  assert.match(account.descriptor, /^elwpkh\(\[3b27f87d\/84h\/1h\/0h\]tpub/);
  assert.deepEqual(elements.deriveAccount(SLOT_24_STARTER, { receive: 0, change: 1 }).change.map((a) => a.address), [
    "elements1q2n6usykz5ycrnfpup3hx0qa0manae07jgvvmuc",
  ]);
  assert.throws(() => elements.deriveAccount("not a starter", { receive: 1 }), /Starter/);
});

const PSETS = JSON.parse(await readFile(path.join(ROOT, "e2e", "fixtures", "elements-psets.json"), "utf8"));

test("the shipped Elements Chain Module decodes a request it can't explain as Blind, with its verifiable facts", async () => {
  const { loadChainModule } = await importWallet();
  const elements = await loadChainModule(await readFile(path.join(DIST_E2E.chromium, "elements.wasm")));
  const decoded = elements.decode(PSETS.blind.payload, SLOT_24_STARTER);
  assert.equal(decoded.kind, "blind");
  assert.deepEqual(decoded.verifiableFacts.ownedInputs.map((i) => [i.index, i.amount]), [[0, "100000"]]);
  assert.deepEqual(decoded.verifiableFacts.fee.map((f) => f.amount), ["1000"]);
});

test("the shipped Elements Chain Module signs its own input exactly as LWK does, and refuses by rule", async () => {
  const { loadChainModule, ChainModuleRefusal } = await importWallet();
  const elements = await loadChainModule(await readFile(path.join(DIST_E2E.chromium, "elements.wasm")));
  assert.equal(elements.sign(PSETS.blind.payload, SLOT_24_STARTER), PSETS.blind.signed);
  assert.throws(
    () => elements.sign(PSETS.wrongGenesis.payload, SLOT_24_STARTER),
    (e) => e instanceof ChainModuleRefusal && e.code === "wrongGenesis",
  );
  assert.throws(
    () => elements.decode(PSETS.confidentialInput.payload, SLOT_24_STARTER),
    (e) => e instanceof ChainModuleRefusal && e.code === "confidential",
  );
});

test("the shipped modules name their chains, what they're for, and their ECX", async () => {
  const { loadChainModule, loadL1Module, describeChain } = await importWallet();
  const l1 = await loadL1Module(await readFile(path.join(DIST_E2E.chromium, "l1.wasm")));
  const elements = await loadChainModule(await readFile(path.join(DIST_E2E.chromium, "elements.wasm")));
  assert.deepEqual(describeChain(l1), {
    name: "Main chain",
    description: "eCash itself",
    chain: "ecash:betanet",
    network: "betanet",
    assets: [{ id: "", ticker: "ECX", name: "eCash", decimals: 8, ecx: true }],
    sends: false,
    officialApps: [],
  });
  assert.deepEqual(describeChain(elements), {
    name: "Elements+",
    description: "Assets and confidential transfers",
    chain: "ecash:betanet-s24",
    network: "betanet",
    assets: [{ id: "5836dcc06130dcf6a65b6ac493813fd65559955283e44cc3f07966294eccb2c8", ticker: "ECX", name: "eCash on Elements+", decimals: 8, ecx: true }],
    sends: true,
    officialApps: ["https://elements-app.invalid"],
    checksNames: "contract",
  });
  // Flush names its assets from their registration (docs/adr/0013); eCash has none to name.
  const flush = await loadChainModule(await readFile(path.join(DIST_E2E.chromium, "flush.wasm")));
  assert.equal(describeChain(flush).checksNames, "registration");
});
