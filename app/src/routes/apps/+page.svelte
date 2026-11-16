<script lang="ts">
  // The Apps view (#91): opens a Sidechain App inside the wallet. Only apps that send
  // `frame-ancestors` for the wallet's origin load there. An app opened here docks beside the
  // wallet (AppDock), which shows home next to it.
  //
  // A link to the wallet can name any page (`#/apps?url=`), and whoever wrote the link picked it:
  // so only a featured app opens from a link at once. Any other is named, by its address, and
  // opens when the user says so. An address they typed here is their say already.
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { listChains } from "$lib/background";
  import { appPage, dockApp } from "$lib/dock.svelte";
  import TopBar from "$lib/TopBar.svelte";

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
  /** Undefined until read: a link's app isn't judged before the featured apps are known. */
  let official = $state<{ origin: string; chain: string }[] | undefined>(undefined);

  listChains().then(
    // Every chain's, on or not: an app's first request asks to turn its chain on.
    (chains) => (official = chains.flatMap((c) => c.officialApps.map((o) => ({ origin: o, chain: c.name })))),
    () => (official = []),
  );

  const isLocal = (hostname: string) => hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "127.0.0.1" || hostname === "[::1]";

  /** A typed address as a URL to open: https unless it names a scheme, or is on this computer. */
  function appUrl(text: string): string | undefined {
    const t = text.trim();
    if (t === "") return undefined;
    try {
      return appPage(/^https?:\/\//i.test(t) ? t : `${isLocal(new URL(`http://${t}`).hostname) ? "http" : "https"}://${t}`);
    } catch {
      return undefined;
    }
  }

  function open(event: SubmitEvent) {
    event.preventDefault();
    const url = appUrl(typed);
    if (url === undefined) return void (typedError = "Enter a web address, like https://app.example.");
    typedError = "";
    dock(url);
  }

  function dock(url: string) {
    if (dockApp(url)) goto("#/", { replaceState: true });
    else refuse();
  }
  const refuse = () => goto("#/apps", { replaceState: true }).then(() => (typedError = "That isn't a web page the wallet can open."));

  /** The link's app as a page to frame, or undefined for anything but a web page (a `javascript:` URL, the wallet's own). */
  const asked = $derived(opened === undefined ? undefined : appPage(opened));
  /** Whether the link's app is featured: those open at once. Undefined until the featured apps are read. */
  const featured = $derived(asked === undefined || official === undefined ? undefined : official.some((o) => o.origin === new URL(asked).origin));

  // Docked, the app stays open while the wallet moves to home.
  $effect(() => {
    if (opened === undefined) return;
    if (asked === undefined) refuse();
    else if (featured) dock(asked);
  });
</script>

{#if asked !== undefined && featured === false}
  {@const url = new URL(asked)}
  <main class="screen" data-app-ask>
    <TopBar title="Open this app?" back="#/apps" />
    <p class="muted small">A link asked the wallet to open this page beside it. It isn't one of the featured apps.</p>
    <div class="card asked">
      <strong class="asked-origin" data-app-ask-origin>{url.origin}</strong>
      {#if url.pathname !== "/" || url.search !== ""}<span class="muted small asked-path">{url.pathname}{url.search}</span>{/if}
    </div>
    <p class="notice small">
      Open it only if you meant to go to this address. The page can show anything it likes, but it is not the wallet: the wallet never asks for your recovery phrase or password inside an app.
    </p>
    <button class="primary" type="button" onclick={() => dock(asked)} data-app-confirm>Open beside the wallet</button>
    <a class="button" href="#/apps" data-app-decline>Don't open</a>
  </main>
{:else if opened === undefined}
  <main class="screen" data-apps>
    <TopBar title="Apps" back="#/" />
    <p class="muted small">Open a Sidechain App inside the wallet. It uses this wallet without a popup. Only apps that support opening in the wallet load here.</p>
    <p class="muted small" data-approval-help>The app opens beside the wallet. When it asks the wallet for something, the wallet's bar turns to <strong>Wallet approval</strong> while you decide. The app can draw anything inside its own frame, so an approval or password prompt without that bar is the app's, not the wallet's.</p>
    <form class="stack" onsubmit={open}>
      <input bind:value={typed} placeholder="https://app.example" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="App address" data-app-address />
      {#if typedError}<p class="error small">{typedError}</p>{/if}
      <button class="primary" type="submit" data-app-open>Open</button>
    </form>
    {#if official && official.length > 0}
      <p class="muted small" data-featured-apps>Featured apps, from each chain's maintainers:</p>
      <ul class="stack">
        {#each official as app (app.origin)}
          <li><a class="card official" href={`#/apps?url=${encodeURIComponent(`${app.origin}/`)}`} data-official-app={app.origin}><strong>{app.origin}</strong><span class="muted small">{app.chain}</span></a></li>
        {/each}
      </ul>
    {/if}
  </main>
{/if}

<style>
  .asked {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .asked-origin,
  .asked-path {
    overflow-wrap: anywhere;
  }
  .official {
    display: flex;
    flex-direction: column;
    gap: 2px;
    text-decoration: none;
    color: var(--text);
  }
</style>
