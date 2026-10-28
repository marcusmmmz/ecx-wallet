<script lang="ts">
  import type { Snippet } from "svelte";
  import Icon from "$lib/Icon.svelte";
  import Mark from "$lib/Mark.svelte";

  /** `back`: where the back arrow goes; without it, the bar shows the wallet's mark instead. */
  let { title, back, actions }: { title: string; back?: string; actions?: Snippet } = $props();
</script>

<header class="sticky-head">
  {#if back}
    <a class="back" href={back} aria-label="Back"><Icon name="back" size={20} /></a>
  {:else}
    <Mark />
  {/if}
  <span class="title">{title}</span>
  {#if actions}<div class="actions">{@render actions()}</div>{/if}
</header>

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
  .title {
    flex: 1;
    font-weight: 700;
    font-size: 1.05rem;
  }
  .actions {
    display: flex;
    gap: 8px;
  }
</style>
