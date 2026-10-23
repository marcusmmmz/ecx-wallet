<script lang="ts">
  import { lockVault, vaultStatus, type VaultStatus } from "$lib/background";
  import Icon from "$lib/Icon.svelte";
  import TopBar from "$lib/TopBar.svelte";
  import { unit } from "$lib/unit.svelte";

  let status = $state<VaultStatus | undefined>(undefined);
  let error = $state("");

  vaultStatus().then((s) => (status = s));

  async function lockNow() {
    try {
      await lockVault();
      location.hash = "#/";
    } catch (e) {
      error = (e as Error).message;
    }
  }
</script>

<main class="screen" data-screen-ready={status ? "" : undefined} data-settings>
  <TopBar title="Settings" back="#/" />

  <ul class="card settings">
    <li>
      <a class="setting" href="#/grants" data-grants-link>
        <Icon name="grants" />
        <span class="grow"><strong class="small">Grants</strong><span class="muted tiny">Sites you've let use your wallet</span></span>
        <Icon name="forward" size={16} />
      </a>
    </li>
    <li>
      <a class="setting" href="#/chains" data-chains-link>
        <Icon name="plus" />
        <span class="grow"><strong class="small">Chains</strong><span class="muted tiny">Turn chains on or off</span></span>
        <Icon name="forward" size={16} />
      </a>
    </li>
    <li>
      <a class="setting" href="#/assets" data-assets-link>
        <Icon name="plus" />
        <span class="grow"><strong class="small">Assets</strong><span class="muted tiny">Name assets by their contract, or label them</span></span>
        <Icon name="forward" size={16} />
      </a>
    </li>
    <li class="setting">
      <Icon name="deposit" />
      <span class="grow"><strong class="small">Amounts in</strong><span class="muted tiny">Every ECX amount, everywhere</span></span>
      <span class="segmented" role="group" aria-label="Amounts in">
        {#each [["ecx", "ECX"], ["sats", "sats"]] as const as [value, label] (value)}
          <button aria-pressed={unit.loaded && unit.value === value} onclick={() => unit.set(value)} data-unit-option={value}>{label}</button>
        {/each}
      </span>
    </li>
    <li class="setting">
      <Icon name="history" />
      <span class="grow">
        <strong class="small">Auto-lock</strong>
        <span class="muted tiny" data-auto-lock>
          {#if status}After {status.autoLockMinutes} {status.autoLockMinutes === 1 ? "minute" : "minutes"} without use{/if}
        </span>
      </span>
    </li>
    {#if status?.unlocked}
      <li>
        <button class="setting" onclick={lockNow} data-lock-now>
          <Icon name="lock" />
          <span class="grow"><strong class="small">Lock now</strong></span>
        </button>
      </li>
    {/if}
  </ul>
  {#if error}<p class="error" role="alert" data-error>{error}</p>{/if}
</main>

<style>
  .settings {
    gap: 0;
    padding: 0;
  }
  .settings li + li {
    border-top: 1px solid var(--border);
  }
  .setting {
    display: flex;
    align-items: center;
    justify-content: flex-start;
    gap: 12px;
    width: 100%;
    min-height: 56px;
    padding: 8px 14px;
    border: none;
    border-radius: 0;
    background: none;
    color: var(--text);
    font-weight: 400;
    text-align: left;
    text-decoration: none;
  }
  a.setting:hover,
  button.setting:hover {
    background: var(--surface-2);
  }
  .settings li:first-child .setting {
    border-radius: var(--radius) var(--radius) 0 0;
  }
  .settings li:last-child .setting {
    border-radius: 0 0 var(--radius) var(--radius);
  }
  .grow {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .segmented {
    display: flex;
    padding: 3px;
    border-radius: 999px;
    background: var(--surface-2);
  }
  .segmented button {
    min-height: 26px;
    padding: 0 10px;
    border: none;
    border-radius: 999px;
    background: none;
    font-size: 0.8rem;
  }
  .segmented button[aria-pressed="true"] {
    background: var(--surface);
    box-shadow: var(--shadow);
  }
</style>
