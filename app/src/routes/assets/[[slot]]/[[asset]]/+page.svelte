<script lang="ts">
  import { page } from "$app/state";
  import {
    addAssetByContract,
    addAssetByRegistration,
    labelAsset,
    listChains,
    listStoredAssets,
    removeAsset,
    type ChainInfo,
    type StoredAsset,
  } from "$lib/background";
  import { assetSource } from "$lib/asset";
  import AssetBadge from "$lib/AssetBadge.svelte";
  import Icon from "$lib/Icon.svelte";
  import TopBar from "$lib/TopBar.svelte";

  /**
   * The asset store, per sidechain that's on (docs/adr/0010): the assets the wallet names beyond its
   * Chain Entry. `#/assets/<slot>/<asset>` opens the form to name that asset (from an "Unknown asset").
   */
  interface Form {
    slot: number;
    /** How it's named: by the chain's own check (`contract`, `registration`), or as the user's label. */
    mode: "contract" | "registration" | "label";
    asset: string;
    contract: string;
    name: string;
    ticker: string;
    precision: string;
    /** Renaming a label: the asset is fixed, and the form is a label. */
    renaming: boolean;
  }

  let chains = $state<ChainInfo[] | undefined>(undefined);
  let stored = $state<Record<number, StoredAsset[]>>({});
  let form = $state<Form | undefined>(undefined);
  let busy = $state(false);
  let error = $state("");
  let loadError = $state("");

  const slots = $derived((chains ?? []).filter((c): c is ChainInfo & { id: number } => c.id !== "l1" && c.on));

  async function load() {
    const all = await listChains();
    const lists = await Promise.all(all.filter((c) => c.id !== "l1" && c.on).map(async (c) => [c.id, await listStoredAssets(c.id as number)] as const));
    stored = Object.fromEntries(lists);
    chains = all;
  }
  load().then(
    () => {
      const slot = Number(page.params.slot);
      if (page.params.asset && slots.some((c) => c.id === slot)) open(slot, { asset: page.params.asset });
    },
    (e) => (loadError = (e as Error).message),
  );

  /** How the wallet checks a name on the Slot's chain: its contract (Elements), its registration (Flush), or not at all. */
  const checks = (slot: number) => slots.find((c) => c.id === slot)?.checksNames;

  function open(slot: number, start: Partial<Form> = {}) {
    error = "";
    const mode = checks(slot) ?? "label";
    form = { slot, mode, asset: "", contract: "", name: "", ticker: "", precision: "0", renaming: false, ...start };
  }

  function rename(slot: number, a: StoredAsset) {
    open(slot, { mode: "label", asset: a.id, name: a.name, ticker: a.ticker, precision: String(a.precision), renaming: true });
  }

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    if (form === undefined) return;
    const f = form;
    busy = true;
    error = "";
    try {
      const asset = f.asset.trim();
      if (f.mode === "contract") await addAssetByContract(f.slot, asset, f.contract.trim());
      else if (f.mode === "registration") await addAssetByRegistration(f.slot, asset);
      else await labelAsset(f.slot, asset, { name: f.name.trim(), ticker: f.ticker.trim(), precision: Number(f.precision) });
      // The list first, so a closed form always means the new entry shows.
      await load();
      form = undefined;
    } catch (err) {
      error = (err as Error).message;
    } finally {
      busy = false;
    }
  }

  async function remove(slot: number, asset: string) {
    busy = true;
    error = "";
    try {
      await removeAsset(slot, asset);
      await load();
      if (form?.asset === asset) form = undefined;
    } catch (err) {
      error = (err as Error).message;
    } finally {
      busy = false;
    }
  }
</script>

<main class="screen" data-screen-ready={chains !== undefined || loadError ? "" : undefined} aria-busy={busy} data-assets-screen>
  <TopBar title="Assets" back="#/settings" />
  <p class="muted small">
    Assets this wallet names beyond the ones each chain's release names. A name from an asset's contract was chosen by its issuer;
    a label is only yours. Removing one only forgets its name.
  </p>

  {#if loadError}<p class="error" role="alert">{loadError}</p>{/if}
  {#if chains === undefined && !loadError}
    <p class="loading"><span class="spinner"></span>Loading…</p>
  {:else if chains !== undefined && slots.length === 0}
    <p class="notice" data-no-chains>Turn on a sidechain to name its assets.</p>
  {/if}

  {#each slots as chain (chain.id)}
    <section class="stack" data-assets-chain={chain.id}>
      <div class="chain-head">
        <h2>{chain.name}</h2>
        <button class="small-button add" onclick={() => open(chain.id)} disabled={busy} data-add-asset>
          <Icon name="plus" size={16} />Add
        </button>
      </div>

      {#if form?.slot === chain.id}
        {@const f = form}
        <form class="card stack" onsubmit={submit} aria-busy={busy} data-asset-form>
          {#if !f.renaming && checks(f.slot) !== undefined}
            {@const checked = checks(f.slot)!}
            <span class="segmented" role="group" aria-label="Name it by">
              <button type="button" aria-pressed={f.mode === checked} onclick={() => (f.mode = checked)} data-form-mode={checked}>
                {checked === "contract" ? "Its contract" : "Its registration"}
              </button>
              <button type="button" aria-pressed={f.mode === "label"} onclick={() => (f.mode = "label")} data-form-mode="label">Your label</button>
            </span>
          {/if}
          <label>
            Asset id
            <input class="mono" bind:value={f.asset} readonly={f.renaming} autocomplete="off" spellcheck="false" data-form-asset />
          </label>
          {#if f.mode === "contract"}
            <label>
              Its contract, exactly as issued (JSON)
              <textarea class="mono" rows="5" bind:value={f.contract} spellcheck="false" data-form-contract></textarea>
            </label>
            <p class="muted tiny">The wallet checks it is the contract this asset was issued with, by the chain's record of its issuance.</p>
          {:else if f.mode === "registration"}
            <p class="muted tiny">
              The wallet reads the transaction that registered this asset and checks that its ticker is the asset's: on Flush, an asset's id is
              its ticker's hash. Its decimals and name come from that registration.
            </p>
          {:else}
            <label>Name <input bind:value={f.name} autocomplete="off" data-form-name /></label>
            <div class="pair">
              <label>Ticker <input bind:value={f.ticker} autocomplete="off" spellcheck="false" data-form-ticker /></label>
              <label>Decimal places <input inputmode="numeric" bind:value={f.precision} data-form-precision /></label>
            </div>
            <p class="muted tiny">For an asset with no contract. It shows as your label, never as a checked name.</p>
          {/if}
          {#if error}<p class="error" role="alert" data-form-error>{error}</p>{/if}
          <div class="buttons">
            <button type="button" onclick={() => (form = undefined)} data-form-cancel>Cancel</button>
            <button class="primary" type="submit" disabled={busy} data-form-submit>
              {f.renaming ? "Rename" : f.mode === "label" ? "Add label" : "Check and add"}
            </button>
          </div>
        </form>
      {/if}

      {#each stored[chain.id] ?? [] as a (a.id)}
        <div class="card stack" data-stored-asset={a.id}>
          <div class="asset-head">
            <strong data-stored-ticker>{a.ticker}</strong><AssetBadge entry={a} />
            <span class="muted small">{a.name}</span>
            <span class="badge" data-stored-source>{assetSource(a)}</span>
          </div>
          <code class="tiny id" data-stored-id>{a.id}</code>
          <p class="muted tiny">
            {a.precision} decimal places{#if a.domain}. Claims the domain <code>{a.domain}</code> (not checked by this wallet){/if}.
          </p>
          <div class="buttons">
            {#if a.source === "label" || a.source === "app"}
              <button class="small-button" onclick={() => rename(chain.id, a)} disabled={busy} data-rename>Rename</button>
            {/if}
            <button class="small-button remove" onclick={() => remove(chain.id, a.id)} disabled={busy} data-remove>Remove</button>
          </div>
        </div>
      {:else}
        {#if form?.slot !== chain.id}<p class="muted small" data-no-assets>No assets named here yet.</p>{/if}
      {/each}
    </section>
  {/each}
  {#if error && form === undefined}<p class="error" role="alert" data-error>{error}</p>{/if}
</main>

<style>
  h2 {
    font-size: 0.95rem;
  }
  .chain-head,
  .asset-head,
  .buttons {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .chain-head {
    justify-content: space-between;
  }
  .asset-head {
    flex-wrap: wrap;
  }
  .buttons {
    justify-content: flex-end;
  }
  .add {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .id {
    overflow-wrap: anywhere;
  }
  .pair {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
  }
  .remove {
    color: var(--danger);
    border-color: var(--danger-border);
  }
  .segmented {
    display: flex;
    align-self: flex-start;
    padding: 3px;
    border-radius: 999px;
    background: var(--surface-2);
  }
  .segmented button {
    min-height: 26px;
    padding: 0 10px;
    border: none;
    border-radius: 999px;
    background: none;
    font-size: 0.8rem;
  }
  .segmented button[aria-pressed="true"] {
    background: var(--surface);
    box-shadow: var(--shadow);
  }
</style>
