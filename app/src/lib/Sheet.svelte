<script lang="ts">
  import type { Snippet } from "svelte";
  import Icon from "$lib/Icon.svelte";

  /** A panel that slides up over the screen, closed by its × or a tap outside it. */
  let { title, onclose, children, ...rest }: { title: string; onclose: () => void; children: Snippet; [data: `data-${string}`]: unknown } = $props();

  // Shown from the page's body, not where it's declared: a glass card (backdrop-filter) or a rising
  // section (transform) would otherwise hold it, and it would open at the card instead of over the
  // screen in view. Beside a docked app the screen is the wallet's column (AppDock's
  // `data-sheet-host`), so it's shown from there, over the wallet and not the app.
  function toBody(node: HTMLElement) {
    (document.querySelector("[data-sheet-host]") ?? document.body).append(node);
    return { destroy: () => node.remove() };
  }
</script>

<svelte:window onkeydown={(e) => e.key === "Escape" && onclose()} />

<div class="scrim" role="presentation" onclick={onclose} use:toBody></div>
<div class="sheet" role="dialog" aria-label={title} {...rest} use:toBody>
  <div class="head">
    <strong>{title}</strong>
    <button class="close" aria-label="Close" onclick={onclose}><Icon name="close" /></button>
  </div>
  {@render children()}
</div>

<style>
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 10;
    background: rgb(0 0 0 / 35%);
    -webkit-backdrop-filter: blur(6px);
    backdrop-filter: blur(6px);
    animation: fade-in 0.25s ease both;
  }
  .sheet {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 11;
    display: flex;
    flex-direction: column;
    gap: 12px;
    max-width: 440px;
    max-height: 85vh;
    margin: 0 auto;
    padding: 16px;
    overflow-y: auto;
    border: 1px solid var(--glass-border);
    border-bottom: none;
    border-radius: 20px 20px 0 0;
    background:
      linear-gradient(180deg, color-mix(in srgb, var(--glass-edge) 35%, transparent), transparent 120px),
      var(--glass-strong);
    -webkit-backdrop-filter: blur(24px) saturate(180%);
    backdrop-filter: blur(24px) saturate(180%);
    box-shadow: inset 0 1px 0 var(--glass-edge), 0 -18px 50px -20px rgb(0 0 0 / 45%);
    transform-origin: 50% 100%;
    animation: sheet-up 0.36s var(--ease-spring) both;
  }
  /* In the wallet's column beside a docked app: held by the column, not the window. */
  :global([data-sheet-host]) > .scrim,
  :global([data-sheet-host]) > .sheet {
    position: absolute;
  }
  :global([data-sheet-host]) > .sheet {
    max-height: 85%;
  }
  /* The grip along its top edge. */
  .sheet::before {
    content: "";
    align-self: center;
    width: 36px;
    height: 4px;
    margin: -6px 0 -4px;
    border-radius: 999px;
    background: var(--border);
    flex: none;
  }
  /* It grows up from the bottom edge rather than sliding in: nothing in it starts off screen. */
  @keyframes sheet-up {
    from {
      transform: scale(0.92, 0.85);
      opacity: 0;
    }
  }
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .close {
    width: 34px;
    min-height: 34px;
    padding: 0;
    border: none;
    border-radius: 50%;
    background: none;
    color: var(--muted);
    transition: transform 0.3s var(--ease-spring), background-color 0.2s;
  }
  .close:hover {
    transform: rotate(90deg);
  }
</style>
