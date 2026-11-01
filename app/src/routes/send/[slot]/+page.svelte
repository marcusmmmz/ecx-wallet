<script lang="ts">
  import { page } from "$app/state";
  import { parseAmount } from "@ecx/wallet";
  import { assetTrust, shortAsset } from "$lib/asset";
  import { hostApprovals, listChains, spendable, startSend, type AssetAmount, type ChainId, type ChainInfo, type SendResult } from "$lib/background";
  import Approval from "$lib/Approval.svelte";
  import Icon from "$lib/Icon.svelte";
  import TopBar from "$lib/TopBar.svelte";
  import { amountText, unit } from "$lib/unit.svelte";

  /** A Slot, or "l1": the main chain sends from this screen too (#40). */
  const slot: ChainId = page.params.slot === "l1" ? "l1" : Number(page.params.slot);
  const main = slot === "l1";
  let info = $state<ChainInfo | undefined>(undefined);
  const assets = $derived(info?.assets ?? []);

  /** One recipient, as typed. */
  interface Row {
    id: number;
    asset: string;
    amount: string;
    address: string;
  }

  let available = $state<AssetAmount[] | undefined>(undefined);
  let loaded = $state(false);
  let nextId = 0;
  let rows = $state<Row[]>([]);
  let busy = $state(false);
  /** The approval of this screen's own request, shown in place of the form while it waits. */
  let approvalId = $state<string | null>(null);
  let done = $state<SendResult | undefined>(undefined);
  let copied = $state(false);
  let error = $state("");

  /** A new row starts on the chain's ECX if the wallet can spend any, else the first spendable asset. */
  const newRow = (): Row => ({
    id: nextId++,
    asset: (available?.find((a) => entryOf(a.asset)?.ecx) ?? available?.[0])?.asset ?? "",
    amount: "",
    address: "",
  });

  // The assets to send are the ones the wallet can spend now, named as the Chain Entry names them.
  Promise.all([listChains().catch(() => []), spendable(slot)]).then(
    ([chains, s]) => {
      info = chains.find((i) => i.id === slot);
      available = s;
      rows = [newRow()];
      loaded = true;
    },
    (e) => {
      error = (e as Error).message;
      loaded = true;
    },
  );

  const entryOf = (asset: string) => assets.find((a) => a.id === asset);
  /** What an amount is typed in: ECX in the chosen unit, another named asset in its own, else base units. */
  function unitOf(asset: string): string {
    const entry = entryOf(asset);
    return entry === undefined ? "base units" : entry.ecx && unit.value === "sats" ? "sats" : entry.ticker;
  }
  /** An option can hold text only: an unverified name says so in words (docs/adr/0015). */
  const nameOf = (asset: string) => {
    const entry = entryOf(asset);
    const name = entry?.ticker ?? `Unknown asset ${shortAsset(asset)}`;
    return assetTrust(entry) === "unverified" ? `⚠ ${name} (not verified)` : assetTrust(entry) === "verified" ? `${name} ✓` : name;
  };

  /** A row's amount in base units; 0 while it doesn't parse (the Send refuses it then). */
  function baseUnits(r: Row): bigint {
    try {
      return BigInt(parseAmount(r.amount, entryOf(r.asset), unit.value));
    } catch {
      return 0n;
    }
  }
  /** Assets the rows add up to more of than the wallet can spend. The module's own check still decides. */
  const overspent = $derived.by(() => {
    if (available === undefined) return [];
    const totals = new Map<string, bigint>();
    for (const r of rows) totals.set(r.asset, (totals.get(r.asset) ?? 0n) + baseUnits(r));
    return [...totals].filter(([asset, total]) => total > BigInt(available!.find((a) => a.asset === asset)?.amount ?? "0")).map(([asset]) => asset);
  });

  function remove(id: number) {
    rows = rows.filter((r) => r.id !== id);
  }

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    error = "";
    done = undefined;
    let outputs;
    try {
      outputs = rows.map((r, i) => {
        try {
          return { asset: r.asset, amount: parseAmount(r.amount, entryOf(r.asset), unit.value), to: { address: r.address.trim() } };
        } catch (err) {
          throw new Error(rows.length > 1 ? `Recipient ${i + 1}: ${(err as Error).message}` : (err as Error).message);
        }
      });
    } catch (err) {
      error = (err as Error).message;
      return;
    }
    busy = true;
    const approvals = hostApprovals((id) => (approvalId = id));
    try {
      done = await startSend(slot, outputs, approvals.host);
    } catch (err) {
      error = (err as Error).message;
    } finally {
      approvals.stop();
      busy = false;
    }
  }

  function copyTxid(txid: string) {
    navigator.clipboard.writeText(txid).catch(() => {});
    copied = true;
    setTimeout(() => (copied = false), 1500);
  }

  const shortTxid = (txid: string) => `${txid.slice(0, 10)}…${txid.slice(-8)}`;
</script>

{#if approvalId !== null}
  <!-- This screen's own request, approved in place: a window would close the toolbar popup. -->
  {#key approvalId}<Approval id={approvalId} hosted ondone={() => (approvalId = null)} />{/key}
{:else}
<main class="screen" data-screen-ready={loaded ? "" : undefined}>
  <TopBar title="Send on {info?.name ?? `Slot ${slot}`}" back="#/chain/{slot}" />

  {#if !loaded}
    <p class="loading"><span class="spinner"></span>Loading…</p>
  {/if}

  {#if done}
    <div class="success sent" role="status" data-send-done>
      <strong>Sent</strong>
      {#if done.txid}
        <span class="txid">
          Transaction <code data-send-txid={done.txid}>{shortTxid(done.txid)}</code>
          <button type="button" class="copy" aria-label="Copy the transaction id" title="Copy" onclick={() => copyTxid(done!.txid!)} data-copy-txid>
            <Icon name={copied ? "check" : "copy"} size={16} />
          </button>
        </span>
      {:else}
        <span>Submitted to {done.server}{done.accepted ? "" : ", which didn't accept it"}.</span>
      {/if}
      <a class="link" href="#/chain/{slot}/activity" data-send-activity>See it in Activity</a>
    </div>
  {:else if available}
    <form class="stack" onsubmit={submit}>
      {#each rows as row, i (row.id)}
        <div class="card" data-send-row={i}>
          {#if rows.length > 1}
            <div class="row-head">
              <strong class="small">Recipient {i + 1}</strong>
              <button type="button" class="copy" aria-label="Remove recipient {i + 1}" title="Remove" onclick={() => remove(row.id)} data-send-remove>
                <Icon name="close" size={16} />
              </button>
            </div>
          {/if}
          <label>
            Asset
            <select bind:value={row.asset} data-send-asset>
              {#each available as a (a.asset)}
                <option value={a.asset}>{nameOf(a.asset)} ({amountText(a.amount, a.asset, assets)} spendable)</option>
              {/each}
            </select>
          </label>
          <label>
            Amount ({unitOf(row.asset)})
            <input inputmode="decimal" bind:value={row.amount} data-send-amount />
          </label>
          <label>
            {main ? "eCash address" : "Destination address"}
            <input class="mono" bind:value={row.address} autocomplete="off" spellcheck="false" data-send-destination />
          </label>
        </div>
      {/each}
      <button type="button" class="small-button add" onclick={() => (rows = [...rows, newRow()])} disabled={available.length === 0} data-send-add>
        <Icon name="plus" size={16} />Add recipient
      </button>
      {#each overspent as asset (asset)}
        <p class="error" role="alert" data-send-overspent>These recipients add up to more {nameOf(asset)} than the wallet can spend.</p>
      {/each}
      {#if main}
        <p class="muted small" data-send-ecash-note>
          eCash addresses look like Bitcoin's (<code>bc1…</code>, <code>1…</code>, <code>3…</code>). This sends ECX on eCash; nothing arrives
          on Bitcoin.
        </p>
      {/if}
      <p class="muted small">
        Spendable is confirmed, plus change from your own sends. You review exactly what will be sent, decoded by this
        wallet, before anything is signed.
      </p>
      <button class="primary block" type="submit" disabled={busy || available.length === 0} data-send-submit>Review and send</button>
    </form>
    {#if busy}<p class="loading small" data-send-waiting><span class="spinner"></span>Waiting for your approval…</p>{/if}
  {/if}

  {#if error}<p class="error" role="alert" data-error>{error}</p>{/if}
</main>
{/if}

<style>
  .row-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .add {
    align-self: flex-start;
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .sent {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .txid {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .copy {
    width: 32px;
    min-height: 32px;
    padding: 0;
    border: none;
    border-radius: 50%;
    background: none;
    color: inherit;
  }
</style>
