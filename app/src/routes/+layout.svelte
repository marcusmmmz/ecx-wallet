<script lang="ts">
  import "../app.css";
  import { approvalRouteChanged } from "$platform";
  import { reportActivity } from "$lib/activity";
  import { onLockDeadline, vaultStatus } from "$lib/background";
  import BottomBar from "$lib/BottomBar.svelte";
  import { page } from "$app/state";
  import { nav, pathOf } from "$lib/nav.svelte";
  import { currentView } from "$lib/view";

  let { children } = $props();

  $effect(reportActivity);
  // The bottom bar: on every screen of an unlocked wallet, but not in an approval window or while setting one up.
  const path = $derived(pathOf(page.url.hash));
  $effect(() => approvalRouteChanged(path));
  const barless = $derived(/^\/(approve|create|import)(\/|$)/.test(path));
  // Until the first answer the bar's place isn't known (`data-bar-known`, which the e2e tests wait for).
  let barKnown = $state(false);
  // When the wallet locks itself without use (asked again then, as the deadline may have moved).
  let locksAt = $state<number | undefined>(undefined);
  const askVault = () =>
    vaultStatus().then(
      (s) => ((nav.unlocked = s.unlocked), (locksAt = s.locksAt), (barKnown = true)),
      () => (barKnown = true),
    );
  $effect(() => {
    void path;
    askVault();
  });
  // A lock on any screen takes the bar away: one the background announces, or the deadline passing.
  $effect(() =>
    onLockDeadline((next) => {
      nav.unlocked = next !== null;
      locksAt = next ?? undefined;
    }),
  );
  $effect(() => {
    if (locksAt === undefined) return;
    const timer = setTimeout(askVault, Math.max(0, locksAt - Date.now()) + 500);
    return () => clearTimeout(timer);
  });
  // app.css sizes the page by where it shows.
  $effect(() => {
    document.documentElement.dataset.view = currentView();
  });
</script>

<!-- The screen scrolls in its own area, above the bottom bar: nothing ever sits under the bar. -->
<div class="frame" data-bar-known={barKnown || undefined}>
  <div class="scroll">{@render children()}</div>
  {#if nav.unlocked && !barless}<BottomBar />{/if}
</div>

<style>
  .frame {
    display: flex;
    flex-direction: column;
    height: 100vh;
  }
  /* The toolbar popup is as tall as the browser lets it be (600px). */
  :global(html[data-view="popup"]) .frame {
    height: 600px;
  }
  .scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
  }
</style>
