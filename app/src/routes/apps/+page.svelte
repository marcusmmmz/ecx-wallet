<script lang="ts">
  // The Apps view (#91): a Sidechain App opened inside the wallet, in a frame this page is the
  // Provider of. Only apps that send `frame-ancestors` for the wallet's origin load here. The bar
  // above the frame names the app as the browser reports it; approvals, unlocking included, are
  // drawn over the frame in the wallet's own UI, so the app stays mounted.
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { closeOverlayApproval, hostApprovals, serveFrame } from "$platform";
  import { listChains } from "$lib/background";
  import Approval from "$lib/Approval.svelte";
  import Icon from "$lib/Icon.svelte";
  import TopBar from "$lib/TopBar.svelte";

  /** How long a loaded page has to say `hello` before the view says it hasn't connected. */
  const SILENT_MS = 3000;
  /** No navigating the wallet's tab (no `allow-top-navigation`); links it opens are normal tabs. */
  const SANDBOX = "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox";

  /**
   * The app's URL: everything after `?url=`, its only parameter. The hash can arrive decoded, so the
   * app's own query (`?a=1&b=2`) would split a URLSearchParams; an encoded one is decoded here.
   */
  const opened = $derived.by(() => {
    const hash = page.url.hash;
    const at = hash.indexOf("?url=");
    if (at === -1) return undefined;
    const raw = hash.slice(at + "?url=".length);
    try {
      return /^https?:\/\//i.test(raw) ? raw : decodeURIComponent(raw);
    } catch {
      return undefined;
    }
  });
  let typed = $state("");
  let typedError = $state("");
  let official = $state<{ origin: string; chain: string }[]>([]);
  let frame = $state<HTMLIFrameElement>();
  /** The origin of the page in the frame, as the browser reported it with its latest message. */
  let origin = $state<string | undefined>(undefined);
  let silent = $state(false);
  let approval = $state<string | undefined>(undefined);

  listChains().then(
    // Every chain's, on or not: an app's first request asks to turn its chain on.
    (chains) => (official = chains.flatMap((c) => c.officialApps.map((o) => ({ origin: o, chain: c.name })))),
    () => {},
  );

  const isLocal = (hostname: string) => hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "127.0.0.1" || hostname === "[::1]";

  /** A typed address as a URL to open: https unless it names a scheme, or is on this computer. */
  function appUrl(text: string): string | undefined {
    const t = text.trim();
    if (t === "") return undefined;
    try {
      const url = new URL(/^https?:\/\//i.test(t) ? t : `${isLocal(new URL(`http://${t}`).hostname) ? "http" : "https"}://${t}`);
      return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined;
    } catch {
      return undefined;
    }
  }

  function open(event: SubmitEvent) {
    event.preventDefault();
    const url = appUrl(typed);
    if (url === undefined) return void (typedError = "Enter a web address, like https://app.example.");
    typedError = "";
    goto(`#/apps?url=${encodeURIComponent(url)}`);
  }

  $effect(() => hostApprovals((id) => (approval = id)));

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

{#if opened === undefined}
  <main class="screen" data-apps>
    <TopBar title="Apps" back="#/" />
    <p class="muted small">Open a Sidechain App inside the wallet. It uses this wallet without a popup. Only apps that support opening in the wallet load here.</p>
    <form class="stack" onsubmit={open}>
      <input bind:value={typed} placeholder="https://app.example" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="App address" data-app-address />
      {#if typedError}<p class="error small">{typedError}</p>{/if}
      <button class="primary" type="submit" data-app-open>Open</button>
    </form>
    {#if official.length > 0}
      <p class="muted small" data-featured-apps>Featured apps, from each chain's maintainers:</p>
      <ul class="stack">
        {#each official as app (app.origin)}
          <li><a class="card official" href={`#/apps?url=${encodeURIComponent(`${app.origin}/`)}`} data-official-app={app.origin}><strong>{app.origin}</strong><span class="muted small">{app.chain}</span></a></li>
        {/each}
      </ul>
    {/if}
  </main>
{:else}
  <main class="app-view" data-app-view>
    <!-- The wallet's own bar, always above the frame: the app can't draw over it. -->
    <header class="app-bar">
      <a class="close" href="#/apps" aria-label="Close the app"><Icon name="close" size={18} /></a>
      <div class="who">
        {#if origin}
          <strong class="origin" data-app-origin>{origin}</strong>
          <span class="muted small">App, not the wallet{isLocal(new URL(origin).hostname) ? " · on this computer" : ""}</span>
        {:else}
          <span class="muted" data-app-origin-unknown>{silent ? "Not connected" : "Connecting…"}</span>
        {/if}
      </div>
    </header>
    {#if silent}
      <div class="notice" data-app-silent>
        <Icon name="warning" />
        <span>This page hasn't connected to the wallet. Either it doesn't allow being opened here, or it doesn't support this wallet. <a href={opened} target="_blank" rel="noopener noreferrer">Open it in a new tab</a>, where it may work with the ECX extension.</span>
      </div>
    {/if}
    <div class="stage">
      {#key opened}
        <iframe bind:this={frame} class="app-frame" src={opened} sandbox={SANDBOX} allow="clipboard-write" referrerpolicy="no-referrer" title="Sidechain App" data-app-frame></iframe>
      {/key}
      {#if approval}
        <div class="overlay" role="dialog" aria-modal="true" aria-label="Wallet approval" data-app-approval>
          {#key approval}
            {@const id = approval}
            <Approval {id} hosted ondone={() => closeOverlayApproval(id)} />
          {/key}
        </div>
      {/if}
    </div>
  </main>
{/if}

<style>
  .official {
    display: flex;
    flex-direction: column;
    gap: 2px;
    text-decoration: none;
    color: var(--text);
  }
  .app-view {
    display: flex;
    flex-direction: column;
    height: 100%;
  }
  .app-bar {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 12px;
    border-bottom: 1px solid var(--border);
    background: var(--surface);
  }
  .close {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    border-radius: 50%;
    color: var(--text);
  }
  .close:hover {
    background: var(--surface-2);
  }
  .who {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .origin {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .app-view > .notice {
    margin: 8px 12px 0;
  }
  .stage {
    position: relative;
    flex: 1;
    min-height: 0;
  }
  .app-frame {
    display: block;
    width: 100%;
    height: 100%;
    border: 0;
    border-top: 3px solid var(--accent);
    background: #fff;
  }
  /* Over the frame, under the wallet's bar: the approval is the wallet's, and so is its password field. */
  .overlay {
    position: absolute;
    inset: 0;
    overflow-y: auto;
    background: var(--bg);
  }
</style>
