<script lang="ts">
  import { assetTrust } from "$lib/asset";
  import Icon from "$lib/Icon.svelte";
  import type { AssetSource } from "@ecx/wallet";

  /**
   * The mark after an asset's ticker (docs/adr/0015): a check if the wallet's own list names it, a
   * warning if only the asset (or an app) says what it is, nothing for the user's own label.
   */
  let { entry, size = 12 }: { entry: { source?: AssetSource; ecx?: boolean } | undefined; size?: number } = $props();
  const trust = $derived(assetTrust(entry));
</script>

{#if trust === "verified"}
  <span class="badge verified" role="img" aria-label="Verified" title="Verified: this wallet's own list of assets names it." data-asset-trust="verified">
    <Icon name="check" size={size} />
  </span>
{:else if trust === "unverified"}
  <span
    class="badge unverified"
    role="img"
    aria-label="Not verified"
    title="Not verified: anyone can make an asset with any name. Check its id before trusting its name."
    data-asset-trust="unverified"
  >
    <Icon name="warning" size={size} />
  </span>
{/if}

<style>
  .badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    vertical-align: -0.1em;
    margin-left: 4px;
    padding: 1px;
    border-radius: 50%;
  }
  .verified {
    color: var(--ok);
    background: var(--ok-bg);
  }
  .unverified {
    color: var(--warn);
    background: var(--warn-bg);
  }
</style>
