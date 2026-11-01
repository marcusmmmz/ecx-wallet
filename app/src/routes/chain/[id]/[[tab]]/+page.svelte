<script lang="ts">
  import { page } from "$app/state";
  import { vaultStatus, type ChainId } from "$lib/background";
  import Actions from "$lib/Actions.svelte";
  import AssetRows from "$lib/AssetRows.svelte";
  import ChainMark from "$lib/ChainMark.svelte";
  import { chainMark, Chains } from "$lib/chains.svelte";
  import ActivityFeed from "$lib/ActivityFeed.svelte";
  import Icon from "$lib/Icon.svelte";
  import type { Tab } from "$lib/nav.svelte";
  import { amountText, unit } from "$lib/unit.svelte";
  import { stalledText } from "$lib/stall";

  /** `l1` for the main chain, else a Slot. */
  const id: ChainId = page.params.id === "l1" ? "l1" : Number(page.params.id);
  const chains = new Chains();
  let locked = $state(false);
  /** `#/chain/<id>/activity` opens on the Activity tab (after a Send, say). */
  let tab = $state<Tab>(page.params.tab === "activity" ? "activity" : "assets");
  let actions = $state<Actions | undefined>(undefined);

  // Nothing here works while locked: the home page asks for the password.
  vaultStatus().then((s) => {
    if (s.unlocked) chains.load(id);
    else locked = true;
  });
  $effect(() => chains.watch(id));

  const view = $derived(chains.get(id));
  const ecxAsset = $derived(view?.info.assets.find((a) => a.ecx));
  const balance = $derived(ecxAsset && view?.shown.report?.balances.find((b) => b.asset === ecxAsset.id));
  const pending = $derived(ecxAsset && view?.shown.report?.unconfirmed.find((u) => u.asset === ecxAsset.id));
  const deposits = $derived(view && Array.isArray(view.deposits) ? view.deposits : []);
  const settled = $derived(
    view !== undefined &&
      (!view.info.on || (!view.shown.refreshing && view.address !== undefined)) &&
      (id === "l1" || (view.deposits !== undefined && view.refused !== undefined)) &&
      (tab !== "activity" || (view.history !== undefined && !view.history.refreshing)),
  );
</script>

<!-- data-settled: every read this screen started has answered (tests close it only then). -->
<main
  class="screen"
  data-screen-ready={view || locked ? "" : undefined}
  data-chain-screen={id}
  data-settled={settled ? "" : undefined}
>
  <header>
    <a class="back" href="#/" aria-label="Back"><Icon name="back" size={20} /></a>
    {#if view}
      <ChainMark {...chainMark(view.info)} size={26} />
      <span class="title-block">
        <span class="title">{view.info.name}</span>
        <span class="mono muted tiny" data-chain-id>{view.info.chain}</span>
      </span>
    {/if}
  </header>

  {#if locked}
    <p class="notice">The wallet is locked. <a href="#/">Unlock it</a> to see this chain.</p>
  {:else if view && !view.info.on}
    <p class="notice" data-chain-off>{view.info.name} is off. <a href="#/chains">Turn it on</a> to see it; your funds on it stay where they are.</p>
  {:else if view}
    <section class="hero">
      {#if ecxAsset && view.shown.report}
        <button class="big" onclick={() => unit.toggle()} title="Show amounts in {unit.value === "ecx" ? "sats" : "ECX"}" data-total data-unit={unit.value}>
          {amountText(balance?.amount ?? "0", ecxAsset.id, view.info.assets)}
        </button>
        {#if pending}<span class="pill pending" data-total-unconfirmed>+{amountText(pending.amount, ecxAsset.id, view.info.assets)} unconfirmed</span>{/if}
      {:else}
        <span class="big muted">—</span>
      {/if}
    </section>
    {#if view.shown.report?.stalledSince}
      <p class="notice" role="status" data-stalled>{stalledText(view.info.name, view.shown.report.stalledSince)}</p>
    {/if}

    <Actions chains={chains.list ?? []} focus={view} bind:this={actions} />

    <div class="tabs" role="tablist">
      <button role="tab" aria-selected={tab === "assets"} onclick={() => (tab = "assets")} data-tab="assets">Assets</button>
      <button role="tab" aria-selected={tab === "activity"} onclick={() => (tab = "activity")} data-tab="activity">
        Activity{#if deposits.length > 0}<span class="count" title="Deposits in progress">{deposits.length}</span>{/if}
      </button>
    </div>

    <div class="panel" role="tabpanel" hidden={tab !== "assets"} data-account={view.info.id} data-refreshing={view.shown.refreshing ? "" : undefined}>
      <AssetRows {view} onretry={() => chains.retry(id)} onreceive={() => actions?.receive(id)} />
      {#if view.shown.report}
        <p class="reported" data-reported-by>Reported by {view.shown.report.server}. This wallet doesn't verify it.</p>
      {/if}
    </div>
    <div class="panel" role="tabpanel" hidden={tab !== "activity"}>
      <ActivityFeed {chains} views={[view]} spenders={[view]} active={tab === "activity"} />
    </div>
  {/if}

  {#if chains.error}
    <p class="error" role="alert" data-error>{chains.error}</p>
  {/if}
</main>

<style>
  header {
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 40px;
  }
  .back {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    margin-left: -6px;
    border-radius: 50%;
    color: var(--text);
  }
  .back:hover {
    background: var(--surface-2);
  }
  .title-block {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .title {
    font-weight: 700;
    font-size: 1.05rem;
    line-height: 1.2;
  }
  .hero {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
  }
  .big {
    min-height: 0;
    padding: 0 6px;
    border: none;
    background: none;
    color: var(--text);
    font-size: 2rem;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    line-height: 1.15;
  }
  .pill {
    padding: 2px 10px;
    border-radius: 999px;
    font-size: 0.8rem;
    font-weight: 600;
  }
  .pending {
    background: var(--pending-bg);
    color: var(--pending);
  }
  .count {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 18px;
    height: 18px;
    margin-left: 6px;
    padding: 0 5px;
    border-radius: 999px;
    background: var(--accent);
    color: var(--on-accent);
    font-size: 0.7rem;
  }
  .panel {
    display: flex;
    flex-direction: column;
    gap: 12px;
    margin-top: -6px;
  }
  .panel[hidden] {
    display: none;
  }
</style>
