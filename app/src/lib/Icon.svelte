<script lang="ts">
  /** Stroke icons, drawn inline: extension pages load no icon fonts or remote images. */
  const PATHS = {
    lock: "M6 11h12v10H6zM8.5 11V7.5a3.5 3.5 0 0 1 7 0V11",
    warning: "M12 3 2 21h20L12 3zM12 10v5M12 18v.01",
    check: "M5 12.5 10 17l9-10",
    back: "M15 5l-7 7 7 7",
    forward: "M9 5l7 7-7 7",
    shield: "M12 3 4.5 6v6c0 4.5 3.2 7.8 7.5 9 4.3-1.2 7.5-4.5 7.5-9V6L12 3z",
    send: "M12 19V5M6 11l6-6 6 6",
    receive: "M12 5v14M6 13l6 6 6-6",
    deposit: "M4 7h11M11 3l4 4-4 4M20 17H9M13 13l-4 4 4 4",
    history: "M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18zM12 7v5l3 2",
    copy: "M9 9h11v11H9zM5 15H4V4h11v1",
    close: "M6 6l12 12M18 6 6 18",
    chevron: "M6 9l6 6 6-6",
    refresh: "M20 11a8 8 0 0 0-14.6-4.4M4 4v3h3M4 13a8 8 0 0 0 14.6 4.4M20 20v-3h-3",
    grants: "M10 14a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM2.5 21a7.5 7.5 0 0 1 15 0M17 4l1.5 1.5L21.5 2.5",
    settings: "M4 6h9M17 6h3M15 4v4M4 12h3M11 12h9M9 10v4M4 18h11M19 18h1M17 16v4",
    qr: "M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 18h2v2h-2zM14 18h2v2h-2zM18 14h2v2h-2z",
    plus: "M12 5v14M5 12h14",
    pin_side: "M4 4h16v16H4zM15 4v16",
    unpin_side: "M14 4h6v6M20 4l-8 8M18 14v6H4V6h6",
    eye_off: "M3 3l18 18M10.6 6.1A9.8 9.8 0 0 1 12 6c5 0 8.5 4 9.5 6a12.7 12.7 0 0 1-2.9 3.6M6.4 7.4A12.6 12.6 0 0 0 2.5 12c1 2 4.5 6 9.5 6a9.5 9.5 0 0 0 4.3-1M9.9 9.9a3 3 0 0 0 4.2 4.2",
  } as const;

  let { name, size = 18 }: { name: keyof typeof PATHS; size?: number } = $props();
</script>

<svg
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
>
  <path d={PATHS[name]} />
</svg>

<style>
  svg {
    flex: none;
  }
</style>
