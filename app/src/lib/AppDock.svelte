<script lang="ts">
  // A Sidechain App docked beside the wallet (#91): the app in a frame on the left, which this page
  // is the Provider of, and the wallet on the right, as the extension's side panel shows it. The
  // wallet's column has its own bar, naming the app as the browser reports it, with the button that
  // closes it. Approvals, unlocking included, are drawn over the wallet's column, so the app stays
  // mounted and in view. On a narrow screen the wallet is drawn over the app when asked for, or
  // when an approval is up.
  //
  // The app picks when an approval appears, so while one is up its frame takes no input (`inert`),
  // focus moves to the approval, its approving buttons wait a moment (Approval's arming), and the
  // wallet's bar, which is outside the app's frame, says it's the wallet's: an approval drawn by
  // the app can't change it.
  import type { Snippet } from "svelte";
  import { closeOverlayApproval, hostApprovals, serveFrame } from "$platform";
  import Approval from "$lib/Approval.svelte";
  import { closeDockedApp } from "$lib/dock.svelte";
  import Icon from "$lib/Icon.svelte";

  let { url, wallet }: { url: string; wallet: Snippet } = $props();

  /** How long a loaded page has to say `hello` before the view says it hasn't connected. */
  const SILENT_MS = 3000;
  /** No navigating the wallet's tab (no `allow-top-navigation`); links it opens are normal tabs. */
  const SANDBOX = "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox";

  let frame = $state<HTMLIFrameElement>();
  /** The origin of the page in the frame, as the browser reported it with its latest message. */
  let origin = $state<string | undefined>(undefined);
  let silent = $state(false);
  let approval = $state<string | undefined>(undefined);
  /** Whose request the approval on show is, as its prompt says. */
  let approvalFor = $state<string | undefined>(undefined);
  /** On a narrow screen: the wallet is shown instead of the app. */
  let walletShown = $state(false);

  const isLocal = (hostname: string) => hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "127.0.0.1" || hostname === "[::1]";

  $effect(() =>
    hostApprovals((id) => {
      approval = id;
      approvalFor = undefined;
    }),
  );

  $effect(() => {
    if (!frame) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = serveFrame(frame, {
      origin: (next) => {
        origin = next;
        if (next !== undefined) silent = false;
      },
      loaded: () => {
        silent = false;
        clearTimeout(timer);
        timer = setTimeout(() => (silent = origin === undefined), SILENT_MS);
      },
    });
    return () => {
      clearTimeout(timer);
      stop();
      origin = undefined;
      silent = false;
    };
  });
</script>

<div class="split" class:wallet-shown={walletShown || approval !== undefined} data-app-view>
  <section class="app-side" aria-label="Sidechain App">
    {#if silent}
      <div class="notice" data-app-silent>
        <Icon name="warning" />
        <span>This page hasn't connected to the wallet. Either it doesn't allow being opened here, or it doesn't support this wallet. <a href={url} target="_blank" rel="noopener noreferrer">Open it in a new tab</a>, where it may work with the ECX extension.</span>
      </div>
    {/if}
    {#key url}
      <iframe bind:this={frame} class="app-frame" inert={approval !== undefined} src={url} sandbox={SANDBOX} allow="clipboard-write" referrerpolicy="no-referrer" title="Sidechain App" data-app-frame></iframe>
    {/key}
  </section>
  <aside class="wallet-side" aria-label="Wallet" data-wallet-side>
    <!-- The wallet's own bar: the app can't draw over it. -->
    <header class="app-bar" class:approving={approval !== undefined} data-app-bar-approval={approval !== undefined || undefined}>
      <div class="who">
        {#if approval !== undefined}
          <strong class="origin" data-app-bar-approval-for>Wallet approval{approvalFor ? ` for ${approvalFor}` : ""}</strong>
          <span class="small">From the wallet, not the app. Only the wallet can show this bar.</span>
        {:else if origin}
          <strong class="origin" data-app-origin>{origin}</strong>
          <span class="muted small">App open beside the wallet{isLocal(new URL(origin).hostname) ? " · on this computer" : ""}</span>
        {:else}
          <span class="muted" data-app-origin-unknown>{silent ? "Not connected" : "Connecting…"}</span>
        {/if}
      </div>
      <button class="toggle" type="button" aria-pressed={walletShown} onclick={() => (walletShown = !walletShown)} data-app-toggle>
        {walletShown ? "App" : "Wallet"}
      </button>
      <button class="close" type="button" aria-label="Close the app" title="Close the app" onclick={closeDockedApp} data-app-close>
        <Icon name="close" size={18} />
      </button>
    </header>
    <div class="wallet-body" data-sheet-host>
      {@render wallet()}
      {#if approval}
        <div class="overlay" role="dialog" aria-modal="true" aria-label="Wallet approval" data-app-approval>
          {#key approval}
            {@const id = approval}
            <Approval {id} hosted focus onshow={(o) => (approvalFor = o)} ondone={() => closeOverlayApproval(id)} />
          {/key}
        </div>
      {/if}
    </div>
  </aside>
</div>

<style>
  .split {
    display: flex;
    height: 100vh;
  }
  .app-side {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .app-side > .notice {
    margin: 8px 12px;
  }
  .app-frame {
    display: block;
    flex: 1;
    min-height: 0;
    width: 100%;
    border: 0;
    background: #fff;
  }
  /* The wallet, as wide as the extension's popup, with the app's accent along the seam. */
  .wallet-side {
    width: 400px;
    flex: none;
    display: flex;
    flex-direction: column;
    border-left: 3px solid var(--accent);
    background: var(--bg);
  }
  .app-bar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 8px 8px 14px;
    border-bottom: 1px solid var(--border);
    background: var(--surface);
  }
  /* The wallet's approval colour: the bar is the one place the app can't imitate it. */
  .app-bar.approving {
    background: var(--accent);
    border-bottom-color: var(--accent);
    color: var(--on-accent);
  }
  .app-bar.approving .close,
  .app-bar.approving .toggle {
    color: var(--on-accent);
    border-color: var(--on-accent);
  }
  .who {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-width: 0;
  }
  .origin {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .close {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    padding: 0;
    border: 0;
    border-radius: 50%;
    background: none;
    color: var(--text);
    cursor: pointer;
  }
  .close:hover {
    background: var(--surface-2);
  }
  .toggle {
    display: none;
  }
  .wallet-body {
    position: relative;
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  /* Over the wallet's column, under its bar: the approval is the wallet's, and so is its password field. */
  .overlay {
    position: absolute;
    inset: 0;
    /* Above the screen's own bars and sheets: a click meant for the approval lands on it. */
    z-index: 20;
    overflow-y: auto;
    background: var(--bg);
  }
  /* Too narrow for both: the wallet's bar on top, then the app, with the wallet drawn over it when
     shown. The app is never hidden or moved, so it keeps its place and takes clicks as soon as the
     wallet is gone. */
  @media (max-width: 760px) {
    .split {
      position: relative;
      flex-direction: column-reverse;
    }
    .wallet-side {
      width: auto;
      border-left: 0;
      border-bottom: 3px solid var(--accent);
    }
    .split:not(.wallet-shown) .wallet-body {
      display: none;
    }
    .split.wallet-shown .wallet-side {
      position: absolute;
      inset: 0;
      z-index: 20;
    }
    .toggle {
      display: block;
      padding: 6px 12px;
      border: 1px solid var(--border);
      border-radius: 999px;
      background: none;
      color: var(--text);
      cursor: pointer;
    }
  }
</style>
