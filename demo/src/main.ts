// A demo Sidechain App, written the way a real one would use the client library: load it from
// the web wallet's site (no npm), find a wallet on load, ask for a Grant from the Connect click
// (the web wallet opens a popup, which needs a click), then read the address and Send.
import type { GrantScope, Provider } from "@ecx/client";

const params = new URLSearchParams(location.search);
// Flush is Slot 46 on mainnet, which the production web wallet serves.
const SLOT = Number(params.get("slot") ?? 46);
const WALLET = params.get("wallet") ?? "https://ecx-wallet.vercel.app/";
const SCOPE = { slots: [SLOT], methods: ["getAddresses", "sendTransfer"] };

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
let provider: Provider | undefined;

function status(text: string, error = false) {
  $("status").textContent = text;
  $("status").classList.toggle("error", error);
}

function failed(error: unknown) {
  const { code, message } = error as { code?: number; message?: string };
  // 4001: the user said no in the wallet; nothing went wrong.
  status(code === 4001 ? "You rejected the request in the wallet." : `${message ?? String(error)}${code === undefined ? "" : ` (${code})`}`, code !== 4001);
}

function show(address: string | undefined) {
  $("connected").hidden = address === undefined;
  $("send").hidden = address === undefined;
  $("disconnected").hidden = address !== undefined;
  $("address").textContent = address ?? "";
}

async function connect() {
  status("Approve the connection in your wallet…");
  try {
    await provider!.request({ method: "connect", params: SCOPE });
    status("Unlock your wallet if it asks…");
    const [first] = (await provider!.request({ method: "getAddresses", params: { slot: SLOT } })) as { address: string }[];
    show(first.address);
    status("");
  } catch (error) {
    failed(error);
  }
}

async function disconnect() {
  try {
    await provider!.request({ method: "disconnect" });
  } catch (error) {
    failed(error);
  }
  show(undefined);
}

async function send(event: SubmitEvent) {
  event.preventDefault();
  const outputs = [{ asset: "", amount: $<HTMLInputElement>("amount").value, to: { address: $<HTMLInputElement>("to").value.trim() } }];
  status("Approve the Send in your wallet…");
  try {
    const { txid } = (await provider!.request({ method: "sendTransfer", params: { slot: SLOT, outputs } })) as { txid: string };
    status(`Sent. Transaction ${txid}`);
  } catch (error) {
    failed(error);
  }
}

// What a site writes: import { discoverProviders } from "https://ecx-wallet.vercel.app/client.js";
const client: typeof import("@ecx/client") = await import(new URL("client.js", WALLET).href);
const [found] = await client.discoverProviders({ webWallet: WALLET });
provider = found?.provider;
$("wallet").textContent = found === undefined ? "none found" : found.info.rdns === "cash.ecx.wallet.web" ? `${found.info.name} at ${WALLET}` : found.info.name;
$<HTMLButtonElement>("connect").disabled = provider === undefined;
$("connect").addEventListener("click", connect);
$("disconnect").addEventListener("click", disconnect);
$<HTMLFormElement>("send-form").addEventListener("submit", send);
// The wallet revoked the Grant (Grants screen, or another tab): back to Connect.
provider?.on("grantChanged", (scope: GrantScope | null) => {
  if (scope === null) show(undefined);
});
