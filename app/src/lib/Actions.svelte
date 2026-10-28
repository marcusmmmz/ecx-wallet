<script lang="ts">
  import ChainMark from "$lib/ChainMark.svelte";
  import { chainMark, type ChainView } from "$lib/chains.svelte";
  import Icon from "$lib/Icon.svelte";
  import QrCode from "$lib/QrCode.svelte";
  import Sheet from "$lib/Sheet.svelte";

  /**
   * Send, Receive and Deposit. On home (`focus` unset) Send and Deposit ask which chain first; on a
   * chain's own screen they go straight to that chain where they can.
   */
  let { chains, focus }: { chains: ChainView[]; focus?: ChainView } = $props();

  let open = $state<"send" | "receive" | "deposit" | undefined>(undefined);
  /** The address just copied, to tick its button. */
  let copied = $state<string | undefined>(undefined);
  /** The chain whose QR code (and full address) the Receive sheet shows unfolded, if any. */
  let qrFor = $state<ChainView["info"]["id"] | undefined>(undefined);

  const slots = $derived(chains.filter((c) => c.info.id !== "l1"));
  /** A Slot's Send needs the wallet to be able to send there, and a fresh balance from its server. */
  const canSend = (c: ChainView) => c.info.sends && c.shown.report !== undefined && c.shown.error === undefined;
  const receiving = $derived(focus ? [focus] : chains);

  function copy(address: string) {
    navigator.clipboard.writeText(address).catch(() => {});
    copied = address;
    setTimeout(() => (copied = copied === address ? undefined : copied), 1500);
  }

  /** Opens the Receive sheet, with `chain`'s QR code unfolded: the "Receive on X" links use it too. */
  export function receive(chain?: ChainView["info"]["id"]) {
    qrFor = chain;
    open = "receive";
  }

  /** An address too long for a row, by its two ends. */
  const shortAddress = (address: string) => (address.length > 24 ? `${address.slice(0, 12)}…${address.slice(-8)}` : address);
</script>

<nav class="actions">
  {#if focus === undefined}
    <button class="action" onclick={() => (open = "send")} data-send-action><span class="circle"><Icon name="send" /></span>Send</button>
  {:else if focus.info.sends}
    <a class="action" class:off={!canSend(focus)} href="#/send/{focus.info.id}" aria-disabled={!canSend(focus)} data-send-link>
      <span class="circle"><Icon name="send" /></span>Send
    </a>
  {/if}
  <button class="action" onclick={() => receive(focus?.info.id)} data-receive-action><span class="circle"><Icon name="receive" /></span>Receive</button>
  {#if focus !== undefined && focus.info.id !== "l1"}
    <a class="action" href="#/deposit/{focus.info.id}" data-deposit-link><span class="circle"><Icon name="deposit" /></span>Deposit</a>
  {:else}
    <button class="action" onclick={() => (open = "deposit")} data-deposit-action><span class="circle"><Icon name="deposit" /></span>Deposit</button>
  {/if}
</nav>

{#if open === "send"}
  <Sheet title="Send from" onclose={() => (open = undefined)} data-send-sheet>
    <ul class="picks">
      {#each chains as c (c.info.id)}
        <li>
          <a
            class="pick"
            class:off={!canSend(c)}
            href={canSend(c) ? `#/send/${c.info.id}` : undefined}
            aria-disabled={!canSend(c)}
            data-send-link={c.info.id}
            data-disabled={canSend(c) ? undefined : ""}
          >
            <ChainMark {...chainMark(c.info)} size={30} />
            <span class="grow">
              <strong>{c.info.name}</strong>
              {#if !canSend(c)}
                <span class="muted tiny">{c.info.sends ? "Needs a fresh balance from its server" : "Sending here isn't built yet"}</span>
              {/if}
            </span>
            <Icon name="forward" size={16} />
          </a>
        </li>
      {/each}
    </ul>
  </Sheet>
{:else if open === "deposit"}
  <Sheet title="Deposit to" onclose={() => (open = undefined)} data-deposit-sheet>
    <p class="muted tiny">A Deposit moves ECX from the main chain to a sidechain.</p>
    {#if slots.length === 0}
      <p class="muted small" data-no-sidechains><a href="#/chains">Turn on a sidechain</a> to deposit to it.</p>
    {:else}
      <ul class="picks">
        {#each slots as c (c.info.id)}
          <li>
            <a class="pick" href="#/deposit/{c.info.id}" data-deposit-link={c.info.id}>
              <ChainMark {...chainMark(c.info)} size={30} />
              <span class="grow"><strong>{c.info.name}</strong></span>
              <Icon name="forward" size={16} />
            </a>
          </li>
        {/each}
      </ul>
    {/if}
  </Sheet>
{:else if open === "receive"}
  <Sheet title="Receive" onclose={() => (open = undefined)} data-receive-sheet>
    <p class="muted tiny">Each chain has its own address. Only send a chain's assets to its own address.</p>
    <ul class="addresses">
      {#each receiving as c (c.info.id)}
        {@const showing = qrFor === c.info.id}
        <li class="address-row" class:showing data-account={c.info.id}>
          <div class="address-head">
            <ChainMark {...chainMark(c.info)} size={28} />
            <span class="grow">
              <strong class="small">{c.info.name}</strong>
              {#if c.address}
                <code class="tiny muted" title={c.address} data-short-address>{shortAddress(c.address)}</code>
              {:else}
                <span class="loading tiny"><span class="spinner"></span>Deriving the address…</span>
              {/if}
            </span>
            {#if c.address}
              <button
                class="copy"
                class:on={showing}
                aria-label="{showing ? 'Hide' : 'Show'} the QR code for {c.info.name}"
                aria-expanded={showing}
                title="QR code"
                onclick={() => (qrFor = showing ? undefined : c.info.id)}
                data-qr-toggle
              >
                <Icon name="qr" size={16} />
              </button>
              <button class="copy" aria-label="Copy {c.info.name} address" title="Copy address" onclick={() => copy(c.address!)} data-copy-address>
                <Icon name={copied === c.address ? "check" : "copy"} size={16} />
              </button>
            {/if}
          </div>
          {#if showing && c.address}
            <div class="qr"><QrCode text={c.address} /></div>
            <code class="address" data-receive-address>{c.address}</code>
            <p class="muted tiny only">Only for {c.info.name} (<span class="mono" data-account-chain>{c.info.chain}</span>).</p>
          {/if}
        </li>
      {/each}
    </ul>
  </Sheet>
{/if}

<style>
  .actions {
    display: flex;
    justify-content: center;
    gap: 28px;
  }
  .action {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    min-height: 0;
    padding: 0;
    border: none;
    background: none;
    color: var(--text);
    font-size: 0.8rem;
    font-weight: 600;
    text-decoration: none;
  }
  .action:hover {
    background: none;
  }
  .circle {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 44px;
    height: 44px;
    border-radius: 50%;
    background: linear-gradient(180deg, color-mix(in srgb, var(--accent), #fff 18%), var(--accent));
    color: var(--on-accent);
    box-shadow: inset 0 1px 0 rgb(255 255 255 / 40%), 0 6px 18px -8px var(--glow);
    transition: transform 0.2s cubic-bezier(0.2, 0.7, 0.2, 1), box-shadow 0.2s;
  }
  .action:hover .circle {
    background: var(--accent-hover);
    transform: translateY(-2px);
    box-shadow: inset 0 1px 0 rgb(255 255 255 / 40%), 0 0 24px var(--glow);
  }
  .off {
    opacity: 0.45;
    pointer-events: none;
  }
  .picks {
    display: flex;
    flex-direction: column;
  }
  .pick {
    display: flex;
    align-items: center;
    gap: 12px;
    min-height: 56px;
    padding: 8px;
    border-radius: var(--radius-sm);
    color: var(--text);
    text-decoration: none;
  }
  .pick:hover {
    background: var(--surface-2);
  }
  .grow {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .addresses {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .address-row.showing {
    border-color: var(--accent);
  }
  .copy.on {
    background: color-mix(in srgb, var(--accent) 14%, transparent);
    color: var(--accent-text);
  }
  .qr {
    align-self: center;
  }
  .only {
    text-align: center;
  }
  .address-row {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
  }
  .address-head {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .copy {
    width: 32px;
    min-height: 32px;
    padding: 0;
    border: none;
    border-radius: 50%;
    background: none;
    color: var(--muted);
  }
  .address {
    padding: 8px 10px;
    border-radius: var(--radius-sm);
    background: var(--surface-2);
    font-size: 0.75rem;
    user-select: all;
  }
</style>
