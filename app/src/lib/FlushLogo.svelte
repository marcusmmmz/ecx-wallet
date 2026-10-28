<script lang="ts">
  /**
   * Flush's mark, as its own app draws it (backbone-flush `flush-betanet`,
   * `src/webui/app/src/chain/chain.json`: `brand.mark`, strokes on a 32 grid; `scripts/appicon.py`:
   * 2.6 wide, round caps).
   */
  const MARK = ["M4 6h24", "M8 12.5h17", "M12 19h10", "M15 25.5h4"];

  let { size = 24 }: { size?: number } = $props();
</script>

<svg
  width={size}
  height={size}
  viewBox="0 0 32 32"
  fill="none"
  stroke="currentColor"
  stroke-width="2.6"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
>
  {#each MARK as d (d)}<path {d} />{/each}
</svg>

<style>
  svg {
    flex: none;
  }
</style>
