<script lang="ts">
  import { onMount } from "svelte";
  import { serveOpener } from "$platform";
  import { vaultStatus } from "$lib/background";
  import TopBar from "$lib/TopBar.svelte";

  // A Sidechain App opened this window to reach the web wallet (#85). Its requests open their
  // approvals here, and the window comes back to this screen after each.
  let serving = $state<boolean | undefined>(undefined);
  let origins = $state<string[]>([]);
  let exists = $state<boolean | undefined>(undefined);

  onMount(() => {
    serving = serveOpener((origin) => (origins = [...origins, origin]));
    vaultStatus().then((s) => (exists = s.exists), () => (exists = undefined));
  });
</script>

<main class="screen" data-provider-window={serving === undefined ? undefined : serving ? "serving" : "unopened"}>
  <TopBar title="Connected app" />
  {#if serving === false}
    <p class="notice" data-provider-unopened>Nothing opened this window. A Sidechain App opens it when it connects to the wallet.</p>
  {:else if serving}
    {#if exists === false}
      <p class="notice" data-provider-no-wallet>This browser has no wallet yet. <a href="#/create">Create one</a> or <a href="#/import">import one</a>, then ask again from the app.</p>
    {/if}
    {#if origins.length === 0}
      <p class="muted" data-provider-waiting>Waiting for the app's request…</p>
    {:else}
      <p class="muted">Requests from:</p>
      <ul class="stack">
        {#each origins as origin (origin)}<li class="card"><strong data-provider-origin>{origin}</strong></li>{/each}
      </ul>
    {/if}
    <p class="muted small">Keep this window open while you use the app. Closing it disconnects the app and locks this window's session.</p>
  {/if}
</main>
