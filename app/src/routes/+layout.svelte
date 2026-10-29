<script lang="ts">
  import "../app.css";
  import { reportActivity } from "$lib/activity";
  import Approval from "$lib/Approval.svelte";
  import { hostPanelApprovals, onLockDeadline, vaultStatus } from "$lib/background";
  import BottomBar from "$lib/BottomBar.svelte";
  import { page } from "$app/state";
  import { nav, pathOf } from "$lib/nav.svelte";
  import { currentView } from "$lib/view";

  let { children } = $props();

  $effect(reportActivity);
  // The bottom bar: on every screen of an unlocked wallet, but not in an approval window or while setting one up.
  const path = $derived(pathOf(page.url.hash));
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
  // Pinned to the side, the panel shows its window's sites' approvals over the screen, oldest first.
  let waiting = $state<string[]>([]);
  $effect(() => {
    if (currentView() !== "panel") return;
    return hostPanelApprovals((ids) => (waiting = ids));
  });
  const shown = $derived(waiting[0]);
  // A site picks when its approval appears, so it could time one under a click meant for the
  // screen: each takes no input until it has been in view a moment (`data-armed`).
  const ARM_MS = 700;
  let armed = $state(false);
  $effect(() => {
    armed = false;
    if (shown === undefined) return;
    const timer = setTimeout(() => (armed = true), ARM_MS);
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
{#if shown !== undefined}
  <!-- A site's request, approved here in the panel rather than in a window of its own. -->
  <div class="panel-approval" data-panel-approval={shown} inert={!armed} data-armed={armed || undefined}>
    {#key shown}<Approval id={shown} hosted ondone={() => (waiting = waiting.filter((id) => id !== shown))} />{/key}
  </div>
{/if}

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
  .panel-approval {
    position: fixed;
    inset: 0;
    z-index: 30;
    overflow-y: auto;
    background: var(--bg);
    animation: fade-in 0.2s ease both;
  }
  .scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
  }
</style>
