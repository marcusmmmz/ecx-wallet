<script lang="ts">
  import { page } from "$app/state";
  import { parseAmount } from "@ecx/wallet";
  import { hostApprovals, l1Cached, l1Reported, listChains, showReport, startDeposit, type ChainInfo, type ChainReport, type ShownReport } from "$lib/background";
  import Approval from "$lib/Approval.svelte";
  import Icon from "$lib/Icon.svelte";
  import TopBar from "$lib/TopBar.svelte";
  import { amountText, unit } from "$lib/unit.svelte";

  const slot = Number(page.params.slot);
  let chains = $state<ChainInfo[]>([]);
  listChains().then((c) => (chains = c), () => {});
  /** The main chain's coin, which a Deposit spends and credits: how its amounts are written. */
  const coin = $derived(chains.find((c) => c.id === "l1")?.assets ?? []);
  const target = $derived(chains.find((c) => c.id === slot)?.name ?? `Slot ${slot}`);
  const sats = (amount: string) => amountText(amount, "", coin);
  /** What the main chain's server reports (this session's last report while scanning), or why it couldn't be read. */
  let shown = $state<ShownReport>({ refreshing: true });
  let amount = $state("");
  let busy = $state(false);
  /** The approval of this screen's own request, shown in place of the form while it waits. */
  let approvalId = $state<string | null>(null);
  let done = $state<{ txid: string; server: string } | undefined>(undefined);
  let error = $state("");

  /** The confirmed sats the main chain's server reports: the only coins a Deposit spends. */
  const available = (report: ChainReport) => report.balances.find((b) => b.asset === "")?.amount ?? "0";
  /** The unconfirmed sats it reports: shown so the user knows why they can't be spent yet. */
  const unconfirmed = (report: ChainReport) => report.unconfirmed.find((u) => u.asset === "")?.amount;
  const readAt = (report: ChainReport) => new Date(report.readAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  // Only shown to help pick an amount: the Deposit scans the coins again itself, so the form
  // doesn't wait for this (the server can take tens of seconds over 40 addresses).
  showReport(l1Cached, l1Reported, (s) => (shown = s));

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    busy = true;
    error = "";
    done = undefined;
    const approvals = hostApprovals((id) => (approvalId = id));
    try {
      done = await startDeposit({ slot, amount: parseAmount(amount, coin.find((a) => a.id === ""), unit.value) }, approvals.host);
    } catch (err) {
      error = (err as Error).message;
    } finally {
      approvals.stop();
      busy = false;
    }
  }
</script>

{#if approvalId !== null}
  <!-- This screen's own request, approved in place: a window would close the toolbar popup. -->
  {#key approvalId}<Approval id={approvalId} hosted ondone={() => (approvalId = null)} />{/key}
{:else}
<main class="screen" data-screen-ready>
  <TopBar title="Deposit to {target}" back="#/" />

  <div class="card">
    <span class="muted small">Available on the main chain (confirmed)</span>
    {#if shown.report}
      <strong class="amount" data-deposit-available>{sats(available(shown.report))}</strong>
      {#if unconfirmed(shown.report) !== undefined}
        <span class="muted small" data-deposit-unconfirmed>+{sats(unconfirmed(shown.report)!)} unconfirmed, usable once confirmed</span>
      {/if}
      <p class="reported">Reported by {shown.report.server}. This wallet doesn't verify it.</p>
    {/if}
    {#if shown.refreshing}
      <p class="loading small" data-deposit-scanning>
        <span class="spinner"></span>
        {shown.report
          ? `Last read at ${readAt(shown.report)}; scanning your main-chain addresses again…`
          : "Scanning your main-chain addresses for confirmed coins…"}
      </p>
    {:else if shown.error !== undefined}
      <p class="error small" data-balance-error>
        {shown.report ? `Couldn't refresh (showing ${readAt(shown.report)}'s)` : "Balance unavailable"}: {shown.error}
      </p>
    {/if}
  </div>

  <form class="stack" onsubmit={submit}>
    <div class="card">
      <label>
        Amount ({unit.value === "ecx" ? "ECX" : "sats"})
        <input inputmode="decimal" bind:value={amount} autocomplete="off" data-deposit-amount />
      </label>
    </div>
    <p class="notice">
      <Icon name="warning" />
      <span>
        A Deposit moves ECX from the main chain to {target}. It is credited to your own address there after its main-chain
        confirmations, once the chain's operator imports it or, on a chain that pays Deposits itself, in its next block. It only
        comes back through a Withdrawal, which takes months.
      </span>
    </p>
    <p class="reported">
      This wallet builds the transaction from your own coins. You review exactly what it built before anything is signed.
    </p>
    <button class="primary block" type="submit" disabled={busy || amount.trim() === ""} data-deposit-submit>Review deposit</button>
  </form>
  {#if busy}
    <p class="loading small" data-deposit-waiting>
      <span class="spinner"></span>Scanning your main-chain coins and building the deposit, then waiting for your approval…
    </p>
  {/if}

  {#if done}
    <p class="success" role="status" data-deposit-done>
      Deposit broadcast through {done.server}. Transaction <code data-deposit-txid>{done.txid}</code>. Its progress shows on
      the home page.
    </p>
  {/if}
  {#if error}<p class="error" role="alert" data-error>{error}</p>{/if}
</main>
{/if}

<style>
  .amount {
    font-size: 1.6rem;
  }
</style>
