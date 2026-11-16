<script lang="ts">
  import "../app.css";
  import { approvalRouteChanged, canFrameApps, serveOpener } from "$platform";
  import { PROVIDER_WINDOW } from "../../../client/src/web-wallet";
  import { reportActivity } from "$lib/activity";
  import AppDock from "$lib/AppDock.svelte";
  import Approval from "$lib/Approval.svelte";
  import { hostPanelApprovals, onLockDeadline, vaultStatus } from "$lib/background";
  import { dock } from "$lib/dock.svelte";
  import { layout, WIDE_MIN_PX } from "$lib/layout.svelte";
  import BottomBar from "$lib/BottomBar.svelte";
  import { page } from "$app/state";
  import { nav, pathOf } from "$lib/nav.svelte";
  import { currentView } from "$lib/view";

  let { children } = $props();

  $effect(reportActivity);
  // A Provider window reloaded on another route (an approval) serves its app again at once, so the
  // app hears `ready` and fails what this page lost. The window keeps its name across reloads.
  if (typeof window !== "undefined" && window.name === PROVIDER_WINDOW) serveOpener(() => {});
  // The bottom bar: on every screen of an unlocked wallet, but not in an approval or Provider window,
  // or while setting one up.
  const path = $derived(pathOf(page.url.hash));
  $effect(() => approvalRouteChanged(path));
  const barless = $derived(/^\/(approve|create|import|provider)(\/|$)/.test(path));
  // Not in a Provider window or a standalone approval: those serve one app already.
  const docked = $derived(canFrameApps && dock.url !== undefined && !/^\/(approve|provider)(\/|$)/.test(path));
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
  // A site picks when its approval appears, so it could time one under a click meant for the
  // screen: like every approval, it takes no approving click until it has been in view a moment
  // (Approval's `data-armed`).
  const shown = $derived(waiting[0]);
  // app.css sizes the page by where it shows.
  $effect(() => {
    document.documentElement.dataset.view = currentView();
  });
  // A desktop-sized window gets the wide layout (layout.svelte.ts) until an app is docked: beside
  // one, the wallet is the compact column again, as the extension shows it.
  let roomy = $state(false);
  $effect(() => {
    if (!canFrameApps || currentView() !== "page") return;
    const media = matchMedia(`(min-width: ${WIDE_MIN_PX}px)`);
    const read = () => (roomy = media.matches);
    read();
    media.addEventListener("change", read);
    return () => media.removeEventListener("change", read);
  });
  $effect(() => {
    layout.wide = roomy && !docked && !barless;
    if (layout.wide) document.documentElement.dataset.layout = "wide";
    else delete document.documentElement.dataset.layout;
  });
</script>

<!-- The screen scrolls in its own area, above the bottom bar: nothing ever sits under the bar. -->
{#snippet wallet()}
  <div class="frame" class:docked={docked} data-bar-known={barKnown || undefined}>
    <div class="scroll">{@render children()}</div>
    {#if nav.unlocked && !barless}<BottomBar />{/if}
  </div>
{/snippet}

<!-- An app opened from the Apps view docks beside the wallet, which keeps working on the right. -->
{#if docked && dock.url}
  <AppDock url={dock.url} {wallet} />
{:else}
  {@render wallet()}
{/if}
{#if shown !== undefined}
  <!-- A site's request, approved here in the panel rather than in a window of its own. -->
  <div class="panel-approval" data-panel-approval={shown}>
    {#key shown}<Approval id={shown} hosted ondone={() => (waiting = waiting.filter((id) => id !== shown))} />{/key}
  </div>
{/if}

<style>
  .frame {
    display: flex;
    flex-direction: column;
    height: 100vh;
  }
  .frame.docked {
    flex: 1;
    height: auto;
    min-height: 0;
  }
  /* Wide: the bar is a rail down the left, the screen beside it. */
  :global(html[data-layout="wide"]) .frame {
    flex-direction: row-reverse;
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
