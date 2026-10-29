// Session storage without extension APIs (no browser needed).
import assert from "node:assert/strict";
import { test } from "node:test";
import { importWallet } from "../harness.mjs";

const { createMemoryStore } = await importWallet();

test("memory storage lists, overwrites and removes keys, including missing keys", async () => {
  const store = createMemoryStore();
  assert.equal(await store.get("missing"), undefined);
  assert.deepEqual(await store.keys(), []);
  await store.set("grant:https://example.org", { slots: [24] });
  await store.set("", false);
  await store.set("grant:https://example.org", { slots: [99] });
  assert.deepEqual((await store.keys()).sort(), ["", "grant:https://example.org"]);
  assert.deepEqual(await store.get("grant:https://example.org"), { slots: [99] });
  assert.equal(await store.get(""), false);
  await store.remove("grant:https://example.org");
  await store.remove("missing");
  assert.deepEqual(await store.keys(), [""]);
});

test("memory storage copies values on write and read, and each session starts empty", async () => {
  const store = createMemoryStore();
  const value = { bytes: new Uint8Array([1, 2]), nested: { deadline: 10 } };
  await store.set("vault:key", value);
  value.bytes[0] = 9;
  value.nested.deadline = 20;
  const read = await store.get("vault:key");
  assert.equal(read.bytes[0], 1);
  assert.equal(read.nested.deadline, 10);
  read.bytes[1] = 9;
  read.nested.deadline = 30;
  const again = await store.get("vault:key");
  assert.equal(again.bytes[1], 2);
  assert.equal(again.nested.deadline, 10);
  const keys = await store.keys();
  keys.push("invented");
  assert.deepEqual(await store.keys(), ["vault:key"]);
  assert.deepEqual(await createMemoryStore().keys(), []);
});
