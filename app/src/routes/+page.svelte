<script lang="ts">
  import { totalAcrossChains } from "@ecx/wallet";
  import { page } from "$app/state";
  import { lockVault, unlockVault, vaultStatus, type VaultStatus } from "$lib/background";
  import Actions from "$lib/Actions.svelte";
  import AssetRows from "$lib/AssetRows.svelte";
  import ChainMark from "$lib/ChainMark.svelte";
  import { chainMark, Chains, onTheWay } from "$lib/chains.svelte";
  import ActivityFeed from "$lib/ActivityFeed.svelte";
  import Icon from "$lib/Icon.svelte";
  import LockCountdown from "$lib/LockCountdown.svelte";
  import Mark from "$lib/Mark.svelte";
  import { nav } from "$lib/nav.svelte";
  import TopBar from "$lib/TopBar.svelte";
  import { amountText, unit } from "$lib/unit.svelte";
  import { stalledText } from "$lib/stall";
  import { canPin, currentView, pinToSide, unpin } from "$lib/view";

  let status = $state<VaultStatus | undefined>(undefined);
  let chains = $state<Chains | undefined>(undefined);
  let password = $state("");
  let error = $state("");
  let busy = $state(false);
  /** Chains whose section in Assets is folded away. */
  let folded = $state<Record<string, boolean>>({});
  let actions = $state<Actions | undefined>(undefined);

  const view = currentView();

  const vaultState = $derived(
    status === undefined ? undefined : !status.exists ? "onboarding" : status.unlocked ? "unlocked" : "locked",
  );

  vaultStatus().then((s) => (status = s));
  // The bottom bar opens home on a panel (`#/?tab=activity`).
  $effect(() => {
    const tab = new URLSearchParams(page.url.hash.split("?")[1] ?? "").get("tab");
    if (tab === "assets" || tab === "activity") nav.tab = tab;
  });
  // The bottom bar shows while the wallet is unlocked.
  $effect(() => {
    nav.unlocked = vaultState === "unlocked";
  });
  $effect(() => {
    nav.deposits = deposits.length;
  });

  // The account screen: read in the background whenever the wallet is (or becomes) unlocked.
  $effect(() => {
    if (vaultState !== "unlocked") {
      chains = undefined;
      return;
    }
    const next = new Chains();
    chains = next;
    next.load();
    return next.watch();
  });

  const list = $derived(chains?.list ?? []);
  const main = $derived(list.find((c) => c.info.id === "l1"));
  /** Every Slot, on or off: their Deposits in progress show either way. */
  const slots = $derived(chains?.slots ?? []);
  /** The main chain's coin: how every ECX total and Deposit is written. */
  const ecx = $derived(main?.info.assets ?? []);
  const total = $derived(totalAcrossChains(list.map((c) => ({ name: c.info.name, assets: c.info.assets, report: c.shown.report }))));
  /** Chains whose first report is in (or failed): the sync's progress, while any is still reading. */
  const synced = $derived(list.filter((c) => !c.shown.refreshing || c.shown.report !== undefined).length);
  /** Chains still unread once their sync is over: a warning, not a state of the sync. */
  const unavailable = $derived(total.unavailable.filter((name) => list.some((c) => c.info.name === name && !c.shown.refreshing)));
  const deposits = $derived(slots.flatMap((s) => (Array.isArray(s.deposits) ? s.deposits : [])));
  const inFlight = $derived(onTheWay(deposits));
  /** The network the whole wallet is on, shown once by its name ("betanet" as BETANET). */
  const network = $derived(main?.info.network);

  async function act(action: () => Promise<VaultStatus>) {
    busy = true;
    error = "";
    try {
      status = await action();
    } catch (e) {
      error = (e as Error).message;
    } finally {
      password = "";
      busy = false;
    }
  }
</script>

<main
  class="screen"
  data-wallet-home
  data-wallet-ready={status ? true : undefined}
  data-vault-state={vaultState}
  data-chains-ready={chains?.all !== undefined ? "" : undefined}
>
  {#if vaultState === "onboarding"}
    <div class="welcome">
      <Mark size={56} />
      <h1>ECX Wallet</h1>
      <p>Set up your wallet. One Master Mnemonic (a 12- or 24-word phrase) controls your funds on eCash and its sidechains.</p>
    </div>
    <nav class="stack">
      <a class="button primary block" href="#/create" data-start-create>Create a new wallet</a>
      <a class="button block" href="#/import" data-start-import>Import a Master Mnemonic</a>
    </nav>
    <p class="notice">
      <Icon name="shield" />
      <span>The wallet stores your Master Mnemonic only encrypted with your password, and never unencrypted.</span>
    </p>
  {:else if vaultState === "locked"}
    <TopBar title="ECX Wallet" />
    <form
      class="card unlock"
      onsubmit={(e) => {
        e.preventDefault();
        act(() => unlockVault(password));
      }}
    >
      <span class="lock-icon"><Icon name="lock" size={26} /></span>
      <h1>Unlock your wallet</h1>
      <label>
        Password
        <input type="password" autocomplete="current-password" bind:value={password} data-password />
      </label>
      <button class="primary block" type="submit" disabled={busy} data-unlock>Unlock</button>
    </form>
  {:else if vaultState === "unlocked"}
    <header class="wallet-head sticky-head">
      <Mark size={30} />
      <span class="title-block">
        <span class="title">ECX Wallet{#if network}<span class="net-tag" data-network>{network}</span>{/if}</span>
        <LockCountdown locksAt={status?.locksAt} onlocked={() => vaultStatus().then((s) => (status = s))} />
      </span>
      {#if view === "popup" && canPin()}
        <button class="icon-button" aria-label="Pin to the side" title="Pin to the side" onclick={() => pinToSide().catch(console.error)} data-pin>
          <Icon name="pin_side" />
        </button>
      {:else if view === "panel"}
        <button class="icon-button" aria-label="Unpin: open in a popup" title="Unpin: open in a popup" onclick={unpin} data-unpin>
          <Icon name="unpin_side" />
        </button>
      {/if}
      <button class="icon-button" disabled={busy} aria-label="Lock" title="Lock" onclick={() => act(lockVault)} data-lock>
        <Icon name="lock" />
      </button>
      {#if synced < list.length}
        <!-- Along the header's bottom edge, between it and the page, while chains are still read. -->
        <div class="sync" role="progressbar" aria-valuemin={0} aria-valuemax={list.length} aria-valuenow={synced} aria-label="Syncing chains" data-syncing>
          <span class="sync-fill" style:width="{((synced + 0.5) / list.length) * 100}%"></span>
          <span class="sync-text tiny">Syncing {synced} of {list.length} chains…</span>
        </div>
      {/if}
    </header>

    {#if unavailable.length > 0}
      <div class="banner warn" role="status">
        <Icon name="warning" size={18} />
        <span data-unavailable>{unavailable.join(", ")} unavailable, not counted</span>
      </div>
    {/if}

    <section class="hero" data-total-ready={list.length > 0 && list.every((c) => !c.shown.refreshing) ? "" : undefined}>
      <span class="muted tiny">{list.length > 1 ? "Total across chains" : "Balance"}</span>
      <button class="big" onclick={() => unit.toggle()} title="Show amounts in {unit.value === "ecx" ? "sats" : "ECX"}" data-total data-unit={unit.value}>
        {#key amountText(total.amount, "", ecx)}<span class="settle">{amountText(total.amount, "", ecx)}</span>{/key}
      </button>
      {#if total.unconfirmed !== "0"}
        <span class="pill pending" data-total-unconfirmed>+{amountText(total.unconfirmed, "", ecx)} unconfirmed</span>
      {/if}
      {#if inFlight !== "0"}
        <button class="pill on-the-way" onclick={() => (nav.tab = "activity")} data-on-the-way>
          +{amountText(inFlight, "", ecx)} in Deposits on the way
        </button>
      {/if}
    </section>

    <Actions chains={list} bind:this={actions} />


    <!-- Both panels stay in the page, the hidden one hidden: each chain's state is read once. -->
    <div class="panel" role="tabpanel" hidden={nav.tab !== "assets"}>
      {#each list as c (c.info.id)}
        {@const subtotal = c.shown.report?.balances.find((b) => b.asset === c.info.assets.find((a) => a.ecx)?.id)}
        <section
          class="chain"
          data-account={c.info.id}
          data-refreshing={c.shown.refreshing ? "" : undefined}
          data-server={c.shown.report?.server}
          data-deposits-ready={c.refusedSend !== undefined && (c.info.id === "l1" || (c.deposits !== undefined && c.refused !== undefined)) ? "" : undefined}
        >
          <div class="chain-head">
            <a class="chain-name" href="#/chain/{c.info.id}" data-chain-link>
              <ChainMark {...chainMark(c.info)} size={24} />
              <strong>{c.info.name}</strong>
            </a>
            <span class="grow"></span>
            {#if c.shown.refreshing}<span class="spinner small-spinner" title="Refreshing"></span>{/if}
            {#if c.shown.report?.stalledSince}
              <span class="pill bad" title={stalledText(c.info.name, c.shown.report.stalledSince)} data-stalled>Stalled</span>
            {/if}
            {#if subtotal}<span class="small subtotal" data-subtotal>{amountText(subtotal.amount, subtotal.asset, c.info.assets)}</span>{/if}
            <button
              class="fold"
              class:up={!folded[c.info.id]}
              aria-label={folded[c.info.id] ? `Show ${c.info.name}` : `Hide ${c.info.name}`}
              aria-expanded={!folded[c.info.id]}
              onclick={() => (folded[c.info.id] = !folded[c.info.id])}
            >
              <Icon name="chevron" size={16} />
            </button>
          </div>
          <div hidden={folded[c.info.id]}>
            <AssetRows view={c} onretry={() => chains?.retry(c.info.id)} onreceive={() => actions?.receive(c.info.id)} />
          </div>
        </section>
      {/each}
      {#if list.length > 0}
        <p class="note">Balances are as each chain's server reports them. This wallet doesn't verify them.</p>
      {/if}
    </div>

    <div class="panel" role="tabpanel" hidden={nav.tab !== "activity"}>
      {#if chains}
        <ActivityFeed {chains} views={list} spenders={chains.all ?? []} active={nav.tab === "activity"} chips />
      {/if}
    </div>
  {/if}

  {#if error || chains?.error}
    <p class="error" role="alert" data-error>{error || chains?.error}</p>
  {/if}
</main>


<style>
  .welcome {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
    padding: 24px 8px 8px;
    text-align: center;
  }
  .welcome h1 {
    font-size: 1.6rem;
  }
  .unlock {
    align-items: center;
    text-align: center;
    padding: 28px 20px 20px;
  }
  .unlock label {
    align-self: stretch;
    text-align: left;
  }
  .lock-icon {
    display: flex;
    padding: 14px;
    border-radius: 50%;
    background: var(--surface-2);
    color: var(--accent-text);
  }
  .wallet-head {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 36px;
  }
  .title-block {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .title {
    display: flex;
    align-items: center;
    gap: 6px;
    font-weight: 700;
    font-size: 1.05rem;
    white-space: nowrap;
  }
  /* The network, while it isn't the real one: a quiet label, uppercase and tracked as eCash's brand does. */
  .net-tag {
    padding: 1px 6px;
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--muted);
    font-size: 0.6rem;
    font-weight: 600;
    letter-spacing: 0.12em;
    line-height: 1.4;
    text-transform: uppercase;
  }
  .icon-button {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 34px;
    min-height: 34px;
    padding: 0;
    border: none;
    border-radius: 50%;
    background: none;
    color: var(--muted);
  }
  .icon-button:hover {
    background: var(--surface-2);
    color: var(--text);
  }
  .hero {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    text-align: center;
  }
  .big {
    min-height: 0;
    padding: 0 6px;
    border: none;
    background: none;
    color: var(--text);
    font-size: 2.25rem;
    font-weight: 700;
    letter-spacing: -0.02em;
    font-variant-numeric: tabular-nums;
    line-height: 1.15;
  }
  /* The total settles in each time it changes. */
  .settle {
    display: inline-block;
    animation: pop 0.45s var(--ease-out) both;
  }
  .big {
    background: linear-gradient(180deg, var(--text) 30%, color-mix(in srgb, var(--text), var(--accent) 45%)) text;
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
  }
  .big:hover {
    background: linear-gradient(180deg, var(--text) 20%, var(--accent)) text;
    -webkit-background-clip: text;
    background-clip: text;
  }
  .pill {
    -webkit-backdrop-filter: var(--glass-blur);
    backdrop-filter: var(--glass-blur);
    min-height: 0;
    padding: 2px 10px;
    border: none;
    border-radius: 999px;
    background: var(--surface-2);
    font-size: 0.8rem;
    font-weight: 600;
  }
  .pill.pending {
    background: var(--pending-bg);
    color: var(--pending);
  }
  .pill.on-the-way {
    background: color-mix(in srgb, var(--accent) 14%, transparent);
    color: var(--accent-text);
  }
  .pill.on-the-way:hover {
    background: color-mix(in srgb, var(--accent) 22%, transparent);
  }
  .pill.bad {
    background: var(--danger-bg);
    color: var(--danger);
  }
  /* A chain that couldn't be read: under the header, above the total, until it's read. */
  .banner {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    border-radius: var(--radius-sm);
    font-size: 0.85rem;
    font-weight: 600;
    animation: rise 0.3s ease both;
  }
  .banner.warn {
    border: 1px solid color-mix(in srgb, var(--warn) 30%, transparent);
    background: color-mix(in srgb, var(--warn-bg) 80%, transparent);
    -webkit-backdrop-filter: var(--glass-blur);
    backdrop-filter: var(--glass-blur);
    color: var(--warn);
  }
  /* The sync's progress: a gold line along the header's bottom edge, its words just under it. */
  .sync {
    position: absolute;
    left: 0;
    right: 0;
    bottom: -1px;
    height: 2px;
    background: color-mix(in srgb, var(--accent) 14%, transparent);
    animation: fade-in 0.3s ease both;
  }
  .sync-fill {
    position: absolute;
    inset: 0 auto 0 0;
    border-radius: 0 999px 999px 0;
    background: linear-gradient(90deg, var(--accent-hover), var(--accent), #ffe7a8, var(--accent));
    background-size: 200% 100%;
    box-shadow: 0 0 10px var(--glow);
    animation: shimmer 1.2s linear infinite;
    transition: width 0.4s ease;
  }
  .sync-text {
    position: absolute;
    top: 6px;
    left: 50%;
    padding: 1px 10px;
    border: 1px solid var(--glass-border);
    border-radius: 999px;
    background: var(--glass-strong);
    -webkit-backdrop-filter: var(--glass-blur);
    backdrop-filter: var(--glass-blur);
    color: var(--muted);
    white-space: nowrap;
    transform: translateX(-50%);
  }
  @keyframes shimmer {
    to {
      background-position: -200% 0;
    }
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
  .chain {
    display: flex;
    flex-direction: column;
  }
  .chain-head {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 44px;
  }
  .chain-name {
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--text);
    text-decoration: none;
  }
  .chain-name:hover {
    color: var(--accent-text);
  }
  .grow {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .subtotal {
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .small-spinner {
    width: 12px;
    height: 12px;
  }
  .fold {
    width: 28px;
    min-height: 28px;
    padding: 0;
    border: none;
    border-radius: 50%;
    background: none;
    color: var(--muted);
    transition: transform 0.15s;
  }
  .fold.up {
    transform: rotate(180deg);
  }
  .note {
    padding: 4px 8px;
    border: 1px dashed var(--border);
    border-radius: var(--radius-sm);
    color: var(--muted);
    font-size: 0.75rem;
    font-style: italic;
    text-align: center;
  }
</style>
