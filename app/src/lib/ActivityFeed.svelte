<script lang="ts">
  import { activityDays, activityKind, localDay, type ActivityKind, type AssetAmount, type TradeEntry } from "@ecx/wallet";
  import { assetSource, shortAsset } from "$lib/asset";
  import AssetBadge from "$lib/AssetBadge.svelte";
  import type { ChainId, HistoryEntry } from "$lib/background";
  import ChainMark from "$lib/ChainMark.svelte";
  import { assetMark, type Chains, type ChainView } from "$lib/chains.svelte";
  import Deposits from "$lib/Deposits.svelte";
  import Icon from "$lib/Icon.svelte";
  import Sheet from "$lib/Sheet.svelte";
  import { amountText } from "$lib/unit.svelte";

  /**
   * The Activity tab: Deposits in progress, then `views`' transactions merged, by day. Reads them
   * the first time it's `active`. With `chips`, the user can narrow it to one chain.
   */
  let {
    chains,
    views,
    slots,
    active,
    chips = false,
  }: { chains: Chains; views: ChainView[]; slots: ChainView[]; active: boolean; chips?: boolean } = $props();

  let read = false;
  $effect(() => {
    if (active && !read) {
      read = true;
      chains.readHistory(views.map((v) => v.info.id));
    }
  });

  /** The chain the chips narrow the transactions to; Deposits in progress show under every chip. */
  let only = $state<ChainId | "all">("all");
  /** What a preconfirmed transaction is (Flush's soft blocks, docs/adr/0012). */
  const PRECONF = "In a block that no eCash block anchors yet. It counts and can be spent; until an anchor covers it, the chain may still replace that block.";

  const shown = $derived(views.filter((v) => only === "all" || v.info.id === only));
  const days = $derived(
    activityDays(
      shown.map((v) => ({ chain: v, entries: v.history?.report?.entries ?? [] })),
      localDay,
    ),
  );
  const refreshing = $derived(views.some((v) => v.history === undefined || v.history.refreshing));
  const ecx = $derived(chains.get("l1")?.info.assets ?? []);
  const anyDeposits = $derived(slots.some((s) => Array.isArray(s.deposits) && s.deposits.length > 0));
  /** The transaction whose details sheet is open. */
  let inspecting = $state<{ chain: ChainView; entry: HistoryEntry } | undefined>(undefined);
  let copied = $state(false);

  const LABELS: Record<ActivityKind, string> = {
    received: "Received",
    sent: "Sent",
    toSelf: "Fee, to yourself",
    deposit: "Deposit",
    depositCredit: "Deposit from the main chain",
    issuance: "Asset issuance",
    reissuance: "Asset reissuance",
    confidential: "Confidential transaction",
    trade: "Trade",
  };
  const ICONS: Record<ActivityKind, "receive" | "send" | "refresh" | "deposit" | "plus" | "eye_off"> = {
    received: "receive",
    sent: "send",
    toSelf: "refresh",
    deposit: "deposit",
    depositCredit: "deposit",
    issuance: "plus",
    reissuance: "plus",
    confidential: "eye_off",
    trade: "refresh",
  };
  function label(entry: HistoryEntry): string {
    const kind = activityKind(entry);
    if (kind !== "deposit") return LABELS[kind];
    return `Deposit to ${chains.get(entry.depositTo!)?.info.name ?? `Slot ${entry.depositTo}`}`;
  }

  function dayLabel(day: string): string {
    if (day === "unconfirmed") return "Not yet confirmed";
    if (day === "undated") return "Confirmed";
    const now = Date.now() / 1000;
    if (day === localDay(now)) return "Today";
    if (day === localDay(now - 86_400)) return "Yesterday";
    const [y, m, d] = day.split("-").map(Number);
    return new Date(y, m - 1, d).toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" });
  }
  const timeOf = (seconds: number) => new Date(seconds * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const minedAt = (seconds: number) => new Date(seconds * 1000).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
  const readAt = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  /** Why an unconfirmed entry the wallet doesn't trust may change, as the row's badge and the details say it. */
  const unconfirmedWhy = (entry: HistoryEntry) =>
    entry.depositFrom !== undefined ? "credited by the chain's operator, not in a block yet" : "sent by someone else, it may still not arrive";
  const signed = (amount: string, text: string) => (amount.startsWith("-") ? text : `+${text}`);

  // Flush trades (docs/adr/0017): one row twice as tall, what it gave above and what came back below.
  const tickerOf = (view: ChainView, asset: string) => view.info.assets.find((a) => a.id === asset)?.ticker ?? "Unknown asset";
  function tradeTitle(view: ChainView, { given, outcome }: TradeEntry): string {
    const selling = given.asset !== "";
    if (outcome.state === "missed") return selling ? "Sale didn't fill" : "Buy didn't fill";
    if (outcome.state !== "filled" || outcome.payout === "queued") return selling ? `Selling ${tickerOf(view, given.asset)}` : "Buying";
    if (!selling) return `Bought ${tickerOf(view, outcome.back.asset)}`;
    return outcome.back.asset === "" ? `Sold ${tickerOf(view, given.asset)}` : `Swapped ${tickerOf(view, given.asset)}`;
  }
  /**
   * What came back, as the row's second half: `reported` while only the market index vouches for
   * it (a coinbase paying it exactly is the chain's word), `queued` until a coinbase pays it.
   */
  function tradeBack(entry: HistoryEntry, { outcome }: TradeEntry): { label: string; amount?: AssetAmount; time?: number; queued?: true; reported?: true } {
    if (outcome.state === "settling") return { label: entry.confirmed ? "Waiting for the market's index" : "Settles once it's in a block" };
    if (outcome.state === "unknown") return { label: "Couldn't read the outcome" };
    const filled = outcome.state === "filled";
    const { back: amount, payout } = outcome;
    if (payout === "queued") return { label: filled ? "Payout" : "Refund", amount, queued: true, reported: true };
    if (payout !== undefined) return { label: filled ? "Paid" : "Refunded", amount, ...(payout.time === undefined ? {} : { time: payout.time }) };
    return { label: filled ? "Received" : "Returned", amount, reported: true };
  }
  const REPORTED = "Reported by the market's index: what a trade's result holds is only in the node's state.";
  /** A fill between ECX and a token, as ECX per whole token. */
  function tradePrice(view: ChainView, { given, outcome }: TradeEntry): string | undefined {
    if (outcome.state !== "filled") return undefined;
    const [ecx, token] = given.asset === "" ? [given, outcome.back] : outcome.back.asset === "" ? [outcome.back, given] : [];
    if (ecx === undefined || token === undefined || BigInt(token.amount) === 0n) return undefined;
    const decimals = view.info.assets.find((a) => a.id === token.asset)?.decimals;
    if (decimals === undefined) return undefined;
    const each = Number(ecx.amount) / 1e8 / (Number(token.amount) / 10 ** decimals);
    return `${each.toPrecision(3)} ECX each`;
  }

  function copy(txid: string) {
    navigator.clipboard.writeText(txid).catch(() => {});
    copied = true;
    setTimeout(() => (copied = false), 1500);
  }
</script>

{#snippet amount(view: ChainView, { asset, amount }: AssetAmount, size: "in-row" | "in-sheet", how: { reported?: true; queued?: true })}
  {@const entry = view.info.assets.find((a) => a.id === asset)}
  {@const named = entry !== undefined}
  {@const out = amount.startsWith("-")}
  <!-- The asset's mark sits beside the amount, so a lettered one isn't read as part of it. -->
  <span class="amount-line">
    <span class="mark" aria-hidden="true"><ChainMark {...assetMark(entry)} size={size === "in-row" ? 16 : 24} /></span>
    <span
      class="amount {size}"
      class:in={!out && !how.queued}
      class:out
      class:queued={how.queued}
      class:reported={how.reported}
      title={how.reported ? REPORTED : undefined}
      data-history-amount
      data-asset={asset}
      data-reported={how.reported ? "" : undefined}
    >
      {how.queued ? "≈ " : ""}{signed(amount, amountText(amount, asset, view.info.assets))}<AssetBadge {entry} />
      {#if !named}
        <!-- A row has room for the words only; the details sheet shows which asset. -->
        <span class="muted tiny unknown" title={asset}>
          Unknown asset{#if size === "in-sheet"}
            <code>{shortAsset(asset)}</code>
            {#if view.info.id !== "l1"}<a class="link" href="#/assets/{view.info.id}/{asset}" data-name-asset>Name it</a>{/if}
          {/if}
        </span>
      {:else if size === "in-sheet" && assetSource(entry)}
        <span class="muted tiny" title={asset} data-asset-source>{assetSource(entry)} <code>{shortAsset(asset)}</code></span>
      {/if}
    </span>
  </span>
{/snippet}

{#snippet amounts(view: ChainView, entry: HistoryEntry, size: "in-row" | "in-sheet")}
  {#each entry.amounts as a (a.asset)}
    {@render amount(view, a, size, {})}
  {/each}
  {#if entry.hidden}
    <span class="muted tiny" data-history-hidden>
      {entry.amounts.length > 0 ? "+ confidential amounts not shown" : "Amount hidden (confidential)"}
    </span>
  {/if}
  {#if entry.results}
    <!-- A Flush result: what it carries is in the node's state, not the transaction (docs/adr/0013). -->
    <span class="muted tiny" data-history-results>+ amounts only the node knows not shown</span>
  {/if}
{/snippet}

{#snippet status(entry: HistoryEntry)}
  {#if entry.confirmed}
    <span data-history-status>
      {#if entry.time !== undefined}<time datetime={new Date(entry.time * 1000).toISOString()}>{timeOf(entry.time)}</time>{:else}Confirmed{/if}
    </span>
    {#if entry.preconfirmed}<span class="pill" title={PRECONF} data-history-preconfirmed>Preconf</span>{/if}
  {:else if entry.trusted}
    <span class="pill" data-history-status>Pending</span>
  {:else}
    {@const why = unconfirmedWhy(entry)}
    <span class="pill warn" title={why[0].toUpperCase() + why.slice(1)} data-history-status>Unconfirmed</span>
  {/if}
{/snippet}

<div class="feed" data-activity data-refreshing={active && refreshing ? "" : undefined}>
  {#if chips && views.length > 1}
    <div class="chips" role="group" aria-label="Chains">
      <button aria-pressed={only === "all"} onclick={() => (only = "all")} data-chip="all">All</button>
      {#each views as v (v.info.id)}
        <button aria-pressed={only === v.info.id} onclick={() => (only = v.info.id)} data-chip={v.info.id}>{v.info.name}</button>
      {/each}
    </div>
  {/if}

  <Deposits {slots} {ecx} onchange={(slot) => chains.readDeposits(slot)} />

  {#each shown as v (v.info.id)}
    {@const h = v.history}
    {#if h?.error !== undefined}
      <p class="problem small" data-history-error>
        <span>{h.report ? `Couldn't refresh ${v.info.name} activity` : `Couldn't load ${v.info.name} activity`}: {h.error}</span>
        <button class="link" onclick={() => chains.readHistory([v.info.id])} data-history-retry><Icon name="refresh" size={12} /> Retry</button>
      </p>
    {/if}
    {#if h?.report && (h.refreshing || h.error !== undefined)}
      <p class="muted tiny" data-read-at>
        {v.info.name}: last read at {readAt(h.report.readAt)}{h.refreshing ? "; refreshing…" : "."}
      </p>
    {/if}
  {/each}

  {#each days as { day, items } (day)}
    <section class="day">
      <h2>{dayLabel(day)}</h2>
      <ul>
        {#each items as { chain, entry } (`${chain.info.id}:${entry.txid}`)}
          {@const kind = activityKind(entry)}
          {#if entry.trade}
            {@const t = entry.trade}
            {@const back = tradeBack(entry, t)}
            {@const given = chain.info.assets.find((a) => a.id === t.given.asset)}
            <li>
              <button
                class="row trade"
                onclick={() => (inspecting = { chain, entry })}
                data-history-entry={entry.txid}
                data-history-chain={chain.info.id}
                data-history-state={entry.confirmed ? "confirmed" : entry.trusted ? "pending" : "unconfirmed"}
                data-trade-state={t.outcome.state}
              >
                <!-- What it gave, an arrow, what came back: each beside its half of the row. -->
                <span class="pair" aria-hidden="true">
                  <ChainMark {...assetMark(given)} size={22} />
                  <span class="pair-arrow"><Icon name="chevron" size={12} /></span>
                  {#if t.outcome.state === "missed"}
                    <span class="pair-end returned"><Icon name="refresh" size={12} /></span>
                  {:else if back.amount}
                    <span class="pair-end" class:faded={back.queued}><ChainMark {...assetMark(chain.info.assets.find((a) => a.id === back.amount?.asset))} size={22} /></span>
                  {:else}
                    <span class="pair-end waiting"><Icon name="history" size={12} /></span>
                  {/if}
                </span>
                <span class="halves">
                  <span class="half">
                    <span class="grow">
                      <strong class="small" data-history-label>{tradeTitle(chain, t)}</strong>
                      <span class="muted tiny meta">
                        {#if views.length > 1}<span>{chain.info.name} ·</span>{/if}
                        {@render status(entry)}
                      </span>
                    </span>
                    <span class="end">
                      {@render amount(chain, { asset: t.given.asset, amount: `-${t.given.amount}` }, "in-row", {})}
                      <!-- Under what it paid for, so the left keeps every row's chain, time and badge on one line. -->
                      <span class="muted tiny" data-trade-fee>fee {amountText(t.fee, "", chain.info.assets)}</span>
                    </span>
                  </span>
                  <span class="half back" class:waiting={back.queued || back.amount === undefined}>
                    <span class="grow line small" data-trade-back>
                      {back.label}{#if back.queued}{" "}<span class="pill">Queued</span>{:else if back.time !== undefined && entry.time !== undefined && timeOf(back.time) !== timeOf(entry.time)}<span class="muted tiny"> · {timeOf(back.time)}</span>{/if}
                    </span>
                    {#if back.amount}
                      <span class="end">{@render amount(chain, back.amount, "in-row", { ...(back.reported ? { reported: true as const } : {}), ...(back.queued ? { queued: true as const } : {}) })}</span>
                    {/if}
                  </span>
                </span>
              </button>
            </li>
          {:else}
          <li>
            <button
              class="row"
              onclick={() => (inspecting = { chain, entry })}
              data-history-entry={entry.txid}
              data-history-chain={chain.info.id}
              data-history-state={entry.confirmed ? "confirmed" : entry.trusted ? "pending" : "unconfirmed"}
            >
              <span class="icon {kind}"><Icon name={ICONS[kind]} size={16} /></span>
              <span class="grow">
                <strong class="small" data-history-label>{label(entry)}</strong>
                <span class="muted tiny meta">
                  {#if views.length > 1}<span>{chain.info.name} ·</span>{/if}
                  {@render status(entry)}
                </span>
              </span>
              <span class="end">{@render amounts(chain, entry, "in-row")}</span>
            </button>
          </li>
          {/if}
        {/each}
      </ul>
    </section>
  {/each}

  {#if !refreshing && days.length === 0 && !anyDeposits && shown.every((v) => v.history?.error === undefined)}
    <p class="muted small empty" data-history-empty>No transactions yet.</p>
  {/if}
  {#each shown as v (v.info.id)}
    {#if v.history?.report?.partial}
      <p class="muted tiny" data-history-more>Older {v.info.name} transactions may not be shown.</p>
    {/if}
  {/each}
  {#if days.length > 0}
    <p class="note">Reported by each chain's server. This wallet doesn't verify it.</p>
  {/if}
</div>

{#if inspecting}
  {@const { chain, entry } = inspecting}
  <Sheet title={entry.trade ? tradeTitle(chain, entry.trade) : label(entry)} onclose={() => (inspecting = undefined)} data-activity-details>
    {#if entry.trade}
      {@const t = entry.trade}
      {@const back = tradeBack(entry, t)}
      {@const price = tradePrice(chain, t)}
      <div class="sheet-amounts" data-trade-sheet>
        <span class="muted tiny">You gave</span>
        {@render amount(chain, { asset: t.given.asset, amount: `-${t.given.amount}` }, "in-sheet", {})}
        <span class="muted tiny">fee {amountText(t.fee, "", chain.info.assets)}{price ? ` · ${price}` : ""}</span>
        <span class="sheet-arrow" aria-hidden="true"><Icon name="chevron" size={16} /></span>
        <span class="muted tiny">{back.label}{back.time !== undefined ? ` at ${timeOf(back.time)}` : ""}</span>
        {#if back.amount}
          {@render amount(chain, back.amount, "in-sheet", { ...(back.reported ? { reported: true as const } : {}), ...(back.queued ? { queued: true as const } : {}) })}
        {/if}
      </div>
    {:else}
      <div class="sheet-amounts">{@render amounts(chain, entry, "in-sheet")}</div>
    {/if}
    <dl class="facts">
      <dt>Status</dt>
      <dd>
        {#if entry.preconfirmed}Preconfirmed. {PRECONF}{:else if entry.confirmed}Confirmed{:else if entry.trusted}Pending{:else}Unconfirmed: {unconfirmedWhy(entry)}{/if}
      </dd>
      {#if entry.time !== undefined}<dt>Mined</dt><dd data-details-mined>{minedAt(entry.time)}</dd>{/if}
      <dt>Chain</dt>
      <dd>{chain.info.name} <span class="mono muted tiny">{chain.info.chain}</span></dd>
      <dt>Transaction</dt>
      <dd class="txid">
        <code data-details-txid>{entry.txid}</code>
        <button class="copy" aria-label="Copy transaction id" title="Copy transaction id" onclick={() => copy(entry.txid)}>
          <Icon name={copied ? "check" : "copy"} size={14} />
        </button>
      </dd>
      {#if entry.trade && "payout" in entry.trade.outcome && typeof entry.trade.outcome.payout === "object"}
        <dt>{entry.trade.outcome.state === "filled" ? "Paid by" : "Refunded by"}</dt>
        <dd class="txid"><code title="The coinbase output that paid it: the wallet paired it by its address and amount" data-details-payout>{entry.trade.outcome.payout.txid}</code></dd>
      {/if}
      {#if entry.trade}
        <dt>Pool</dt>
        <dd class="txid"><code>{entry.trade.pool}</code></dd>
      {/if}
      {#if entry.depositFrom !== undefined}
        <dt>Deposit</dt>
        <dd class="txid"><code title="The Deposit's transaction on the main chain" data-details-deposit-from>{entry.depositFrom}</code></dd>
      {/if}
    </dl>
    {#if entry.trade?.outcome.state === "unknown"}
      <p class="problem small" data-trade-error>
        <span>Couldn't read the outcome: {entry.trade.outcome.error}</span>
        <button class="link" onclick={() => chains.readHistory([chain.info.id])}><Icon name="refresh" size={12} /> Retry</button>
      </p>
    {/if}
    {#if entry.trade && "payout" in entry.trade.outcome && entry.trade.outcome.payout !== undefined}
      <p class="muted small">
        {entry.trade.outcome.payout === "queued"
          ? "Flush pays this from a queue, in a coinbase to come. The amount is the market's index's word."
          : "Nothing on the chain links a coinbase to its trade: the wallet paired them by the trade's payout address and the exact amount."}
      </p>
    {/if}
    {#if chain.history?.report}
      <p class="reported" data-details-reported-by>Reported by {chain.history.report.server}. This wallet doesn't verify it.</p>
    {/if}
  </Sheet>
{/if}

<style>
  .feed {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .chips button {
    min-height: 28px;
    padding: 0 12px;
    border-radius: 999px;
    font-size: 0.8rem;
  }
  .chips button[aria-pressed="true"] {
    border-color: var(--text);
    background: var(--text);
    color: var(--bg);
  }
  .day {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .day h2 {
    padding-top: 6px;
  }
  .row {
    display: flex;
    align-items: center;
    justify-content: flex-start;
    gap: 12px;
    width: 100%;
    min-height: 56px;
    padding: 8px 0;
    border: none;
    border-bottom: 1px solid var(--border);
    border-radius: 0;
    background: none;
    font-weight: 400;
    text-align: left;
  }
  .row:hover {
    background: color-mix(in srgb, var(--accent) 5%, transparent);
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
    color: var(--text);
  }
  .icon.received {
    color: var(--ok);
  }
  .icon.deposit,
  .icon.depositCredit {
    color: var(--accent-text);
  }
  .grow {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .meta {
    display: flex;
    white-space: nowrap;
    align-items: center;
    gap: 4px;
  }
  .end {
    flex: none;
    max-width: 55%;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    text-align: right;
  }
  .amount-line {
    display: inline-flex;
    align-items: baseline;
    justify-content: flex-end;
    gap: 4px;
  }
  .amount-line .mark {
    display: inline-flex;
    align-self: center;
  }
  /* In the sheet, where an asset's name comes from goes under its amount, not beside it. */
  .sheet-amounts .amount-line {
    flex-wrap: wrap;
    justify-content: center;
  }
  .amount.in-sheet [data-asset-source] {
    display: block;
  }
  .amount {
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
  .amount.out {
    color: var(--danger);
  }
  .amount.queued {
    color: var(--muted);
    font-weight: 500;
  }
  .amount.reported {
    text-decoration: underline dotted;
    text-underline-offset: 3px;
    cursor: help;
  }
  /* A trade (docs/adr/0017): twice a row's height, what it gave above and what came back below. */
  .row.trade {
    min-height: 80px;
    align-items: stretch;
  }
  .pair {
    flex: none;
    width: 36px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: space-between;
    padding: 6px 0 4px;
  }
  .pair-arrow {
    display: inline-flex;
    color: var(--muted);
  }
  .pair-end {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 22px;
    min-height: 22px;
    border-radius: 50%;
  }
  .pair-end.faded {
    opacity: 0.45;
  }
  .pair-end.returned {
    background: var(--warn-bg);
    color: var(--warn);
  }
  .pair-end.waiting {
    background: var(--surface-2);
    color: var(--muted);
  }
  .halves {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .half {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 40px;
  }
  .half.back {
    min-height: 30px;
    border-top: 1px dashed var(--border);
  }
  .half.waiting {
    color: var(--muted);
  }
  .line {
    flex: 1;
    min-width: 0;
  }
  .sheet-arrow {
    display: inline-flex;
    color: var(--muted);
    padding: 2px 0;
  }
  .amount.in-row {
    font-size: 0.85rem;
  }
  .amount.in-sheet {
    font-size: 1.5rem;
  }
  /* An unnamed asset's id goes under its amount, never into the row's text. */
  .unknown {
    display: block;
    font-weight: 400;
  }
  .amount.in {
    color: var(--ok);
  }
  .pill {
    padding: 0 6px;
    border-radius: 999px;
    background: var(--pending-bg);
    color: var(--pending);
    font-weight: 600;
  }
  .pill.warn {
    background: var(--warn-bg);
    color: var(--warn);
    cursor: help;
  }
  .problem {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 8px;
    color: var(--danger);
    overflow-wrap: anywhere;
  }
  .empty {
    padding: 16px 0;
    text-align: center;
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
  .sheet-amounts {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
  }
  .facts {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 6px 12px;
    font-size: 0.85rem;
  }
  .facts dt {
    color: var(--muted);
  }
  .txid {
    display: flex;
    align-items: flex-start;
    gap: 4px;
  }
  .txid code {
    font-size: 0.72rem;
  }
  .copy {
    flex: none;
    width: 24px;
    min-height: 24px;
    padding: 0;
    border: none;
    background: none;
    color: var(--muted);
  }
</style>
