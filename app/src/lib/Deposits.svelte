<script lang="ts">
  import { dismissDeposit, dismissRefusedDeposit, dismissRefusedSend } from "$lib/background";
  import { depositState, type ChainView } from "$lib/chains.svelte";
  import Icon from "$lib/Icon.svelte";
  import { amountText } from "$lib/unit.svelte";

  /**
   * The Deposits in progress to `slots`, and each one's last Deposit and Send that failed after approval.
   * `ecx` names the main chain's coin, in which a Deposit's value is counted.
   */
  let { slots, ecx, onchange }: { slots: ChainView[]; ecx: ChainView["info"]["assets"]; onchange: (slot: number) => void } = $props();

  const list = $derived(slots.flatMap((s) => (Array.isArray(s.deposits) ? s.deposits : [])));
  const errors = $derived(slots.flatMap((s) => (s.deposits !== undefined && "error" in s.deposits ? [{ name: s.info.name, error: s.deposits.error }] : [])));
  const refused = $derived(slots.flatMap((s) => (s.refused ? [s.refused] : [])));
  const refusedSends = $derived(slots.flatMap((s) => (s.refusedSend ? [{ failed: s.refusedSend, assets: s.info.assets }] : [])));
  /** The main-chain confirmations the listed Deposits wait for, if they all wait for the same. */
  const depositConfirmations = $derived.by(() => {
    const each = new Set(list.flatMap((d) => ("depositConfirmations" in d ? [d.depositConfirmations] : [])));
    return each.size === 1 ? [...each][0] : undefined;
  });
  const sats = (value: string) => amountText(value, "", ecx);

  async function stopTracking(slot: number, txid: string) {
    await dismissDeposit(txid).catch(() => {});
    onchange(slot);
  }

  /** A refused Send in a few words: its amount for one recipient, else how many. */
  function sendText({ outputs }: { outputs: { asset: string; amount: string }[] }, assets: ChainView["info"]["assets"]) {
    return outputs.length === 1 ? `of ${amountText(outputs[0].amount, outputs[0].asset, assets)}` : `to ${outputs.length} recipients`;
  }

  async function closeRefusedSend(slot: number) {
    await dismissRefusedSend(slot).catch(() => {});
    onchange(slot);
  }

  async function closeRefused(slot: number) {
    await dismissRefusedDeposit(slot).catch(() => {});
    onchange(slot);
  }
</script>

{#each refused as failed (failed.slot)}
  <div class="error small refused" role="alert">
    <div class="stack-tight">
      <span data-deposit-refused>Your Deposit of {sats(failed.value)} failed: {failed.reason}</span>
      <a href="#/deposit/{failed.slot}" data-deposit-retry>Try again</a>
    </div>
    <button class="close" aria-label="Close" title="Close" onclick={() => closeRefused(failed.slot)} data-deposit-refused-close>×</button>
  </div>
{/each}
{#each refusedSends as { failed, assets } (failed.slot)}
  <div class="error small refused" role="alert">
    <div class="stack-tight">
      <span data-send-refused>Your Send {sendText(failed, assets)} failed: {failed.reason}</span>
      <a href="#/send/{failed.slot}" data-send-retry>Try again</a>
    </div>
    <button class="close" aria-label="Close" title="Close" onclick={() => closeRefusedSend(failed.slot)} data-send-refused-close>×</button>
  </div>
{/each}
{#each errors as { name, error } (name)}
  <p class="error small" data-deposits-error>{name} Deposits unavailable: {error}</p>
{/each}
{#if list.length > 0}
  <section class="in-progress">
    <h2>In progress</h2>
    <ul>
      {#each list as d (d.txid)}
        <li class="deposit" data-deposit={d.txid} data-deposit-state={d.state}>
          <span class="icon"><Icon name="deposit" size={16} /></span>
          <div class="body">
            <div class="head">
              <strong class="small">Deposit to {d.chainName}</strong>
              <strong class="small amount">{sats(d.value)}</strong>
            </div>
            {#if d.state === "confirming"}
              <div class="bar" role="progressbar" aria-valuemin={0} aria-valuemax={d.depositConfirmations} aria-valuenow={d.confirmations}>
                <span style:width="{Math.min((d.confirmations / d.depositConfirmations) * 100, 100)}%"></span>
              </div>
            {/if}
            <span class="tiny" class:muted={d.state !== "notFound"} class:bad={d.state === "notFound"} data-deposit-status>{depositState(d)}</span>
            <code class="tiny muted txid" title="Transaction id on the main chain" data-deposit-txid>{d.txid}</code>
            {#if d.state === "awaitingCredit" && d.claim}
              <details data-claim>
                <summary class="tiny">Show claim details</summary>
                <p class="muted tiny">
                  Anyone running the chain's node can credit it with <code>importdrivechaindeposit</code> and these arguments:
                </p>
                <dl class="claim">
                  <dt>txid</dt><dd><code data-claim-txid>{d.claim.txid}</code></dd>
                  <dt>vout</dt><dd><code data-claim-vout>{d.claim.vout}</code></dd>
                  <dt>Block hash</dt><dd><code data-claim-block>{d.claim.blockHash}</code></dd>
                  <dt>Address</dt><dd><code data-claim-address>{d.claim.address}</code></dd>
                  <dt>Value (sats)</dt><dd><code data-claim-value>{d.claim.value}</code></dd>
                </dl>
              </details>
            {/if}
            {#if d.state === "notFound" || d.state === "unavailable"}
              <!-- Only for a stuck Deposit: the transaction is unaffected, the wallet just stops following it. -->
              <button class="small-button stop" onclick={() => stopTracking(d.slot, d.txid)} data-deposit-stop-tracking>Stop tracking</button>
            {/if}
          </div>
        </li>
      {/each}
    </ul>
    <p class="muted tiny" data-deposits-note>{depositConfirmations === undefined ? "Deposits wait for main-chain confirmations" : `Deposits wait ${depositConfirmations} main-chain blocks`}, then the chain's operator credits them, or on a chain that pays them itself, its next block. Withdrawals take months.</p>
  </section>
{/if}

<style>
  .in-progress {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .deposit {
    display: flex;
    gap: 12px;
    padding: 10px 0;
    border-bottom: 1px solid var(--border);
  }
  .icon {
    display: flex;
    align-items: center;
    justify-content: center;
    flex: none;
    width: 36px;
    height: 36px;
    border-radius: 50%;
    background: var(--surface-2);
    color: var(--accent-text);
  }
  .body {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .head {
    display: flex;
    justify-content: space-between;
    gap: 8px;
  }
  .bar {
    height: 6px;
    margin: 2px 0;
    border-radius: 3px;
    background: var(--surface-2);
    overflow: hidden;
  }
  .bar span {
    display: block;
    height: 100%;
    background: var(--accent);
  }
  .bad {
    color: var(--danger);
  }
  .txid {
    overflow-wrap: anywhere;
  }
  .stop {
    align-self: flex-start;
    margin-top: 4px;
  }
  .claim {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 2px 10px;
    font-size: 0.75rem;
  }
  .claim dd {
    overflow-wrap: anywhere;
  }
  .refused {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 8px;
  }
  .refused .close {
    flex: none;
    min-height: 0;
    padding: 0 4px;
    border: none;
    background: none;
    color: inherit;
    font-size: 1.2rem;
    line-height: 1;
  }
  .stack-tight {
    display: flex;
    flex-direction: column;
  }
</style>
