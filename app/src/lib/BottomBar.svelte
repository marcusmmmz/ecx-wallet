<script lang="ts">
  import { page } from "$app/state";
  import { canFrameApps } from "$platform";
  import Icon from "$lib/Icon.svelte";
  import { nav, pathOf, type Tab } from "$lib/nav.svelte";

  const route = $derived(pathOf(page.url.hash));
  const onHome = $derived(route === "/");
  const atSettings = $derived(route.startsWith("/settings") || route.startsWith("/grants") || route.startsWith("/assets"));

  /** On home, a panel switches in place, as a tab does; elsewhere the link opens home on it. */
  function switchTo(event: MouseEvent, tab: Tab) {
    if (!onHome) return;
    event.preventDefault();
    nav.tab = tab;
  }
</script>

<!-- Docked to the bottom edge as each screen's header is to the top: it stays put while the page scrolls. -->
<nav class="bottom-bar" aria-label="Wallet">
  <div class="bar-items" role={onHome ? "tablist" : undefined}>
    <!-- Links, so any screen can open home on a panel (`?tab=`). -->
    <a
      class="bar-item"
      href="#/?tab=assets"
      onclick={(e) => switchTo(e, "assets")}
      role={onHome ? "tab" : undefined}
      aria-selected={onHome ? nav.tab === "assets" : undefined}
      data-nav="assets"
      data-tab={onHome ? "assets" : undefined}
    >
      <Icon name="wallet" size={20} />
      <span>Assets</span>
    </a>
    <a
      class="bar-item"
      href="#/?tab=activity"
      onclick={(e) => switchTo(e, "activity")}
      role={onHome ? "tab" : undefined}
      aria-selected={onHome ? nav.tab === "activity" : undefined}
      data-nav="activity"
      data-tab={onHome ? "activity" : undefined}
    >
      <span class="bar-icon">
        <Icon name="history" size={20} />
        {#if nav.deposits > 0}<span class="count" title="Deposits in progress">{nav.deposits}</span>{/if}
      </span>
      <span>Activity</span>
    </a>
  </div>
  {#if canFrameApps}
    <a class="bar-item" href="#/apps" aria-current={route === "/apps" ? "page" : undefined} data-nav="apps" data-apps-link>
      <Icon name="apps" size={20} />
      <span>Apps</span>
    </a>
  {/if}
  <a class="bar-item" href="#/chains" aria-current={route === "/chains" ? "page" : undefined} data-nav="chains" data-chains-link-bar>
    <Icon name="layers" size={20} />
    <span>Chains</span>
  </a>
  <a class="bar-item" href="#/settings" aria-current={atSettings ? "page" : undefined} data-nav="settings" data-settings-link>
    <Icon name="settings" size={20} />
    <span>Settings</span>
  </a>
</nav>

<style>
  /* The bottom bar: Assets and Activity switch the panel, Chains opens its quick menu, Settings its screen. */
  /* Below the screen's scrolling area, as the header is above it: it stays put while the page scrolls. */
  .bottom-bar {
    flex: none;
    z-index: 6;
    display: flex;
    width: 100%;
    gap: 2px;
    max-width: 440px;
    margin: 0 auto;
    padding: 6px 10px 8px;
    border-top: 1px solid var(--glass-border);
    background: color-mix(in srgb, var(--bg) 62%, transparent);
    -webkit-backdrop-filter: var(--glass-blur);
    backdrop-filter: var(--glass-blur);
  }
  .bar-items {
    display: contents;
  }
  .bar-item {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 2px;
    min-height: 50px;
    padding: 0;
    border: none;
    border-radius: 15px;
    background: none;
    color: var(--muted);
    font-size: 0.7rem;
    font-weight: 600;
    text-decoration: none;
    transition: color 0.2s, background-color 0.25s, transform 0.25s var(--ease-spring);
  }
  .bar-item:hover {
    background: color-mix(in srgb, var(--surface-2) 60%, transparent);
    color: var(--text);
  }
  .bar-item:active {
    transform: scale(0.94);
  }
  .bar-item[aria-selected="true"],
  .bar-item[aria-current="page"] {
    background: linear-gradient(180deg, color-mix(in srgb, var(--accent) 22%, transparent), color-mix(in srgb, var(--accent) 8%, transparent));
    box-shadow: inset 0 1px 0 var(--glass-edge);
    color: var(--accent-text);
  }
  .bar-item[aria-selected="true"] :global(svg),
  .bar-item[aria-current="page"] :global(svg) {
    animation: pop 0.4s var(--ease-spring);
  }
  .bar-icon {
    position: relative;
    display: flex;
  }
  .count {
    position: absolute;
    top: -6px;
    right: -12px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 18px;
    height: 18px;
    padding: 0 5px;
    border-radius: 999px;
    background: var(--accent);
    color: var(--on-accent);
    font-size: 0.7rem;
  }
</style>
