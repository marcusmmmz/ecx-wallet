<script lang="ts">
  // One approval: the approval window's whole page (routes/approve), or shown in place by the wallet
  // page whose own request it is (`hosted`: the Send and Deposit screens, in the toolbar popup).
  import {
    getApproval,
    listChains,
    resolveApproval,
    unlockApproval,
    type ApprovalPrompt,
    type AssetAmount,
    type ChainInfo,
    type ClearView,
    type DangerousMode,
  } from "$lib/background";
  import { formatAllDecimals } from "@ecx/wallet";
  import { assetSource, shortAsset } from "$lib/asset";
  import AssetBadge from "$lib/AssetBadge.svelte";
  import Icon from "$lib/Icon.svelte";
  import { amountText } from "$lib/unit.svelte";

  /** `ondone`: the approval has nothing more to show (answered, or closed by the background). */
  let { id, ondone, hosted = false }: { id: string; ondone: () => void; hosted?: boolean } = $props();
  let prompt = $state<ApprovalPrompt | null | undefined>(undefined);
  let busy = $state(false);
  let blindOptIn = $state(false);
  let password = $state("");
  let error = $state("");

  function load() {
    prompt = undefined;
    getApproval(id).then(
      (p) => {
        prompt = p;
        // In place, nothing left to show means going back to the screen that asked.
        if (p === null && hosted) ondone();
      },
      () => (prompt = null),
    );
  }
  load();

  // Amounts are the Decoder's, in base units; the Chain Entries say how to write them, in the
  // unit every other screen uses.
  let chains = $state<ChainInfo[]>([]);
  listChains().then((c) => (chains = c), () => {});

  async function decide(approved: boolean) {
    busy = true;
    await resolveApproval(id, approved, { blindSigning: approved && blindOptIn });
    // The background also closes a window; closing here too keeps that from depending on a browser quirk.
    ondone();
  }

  async function unlock(e: SubmitEvent) {
    e.preventDefault();
    busy = true;
    error = "";
    try {
      await unlockApproval(id, password);
      // The background now prepares the request itself. If unlocking was all it needed (an app's
      // getAddresses), there's nothing more to show: close, rather than be closed mid-reply.
      prompt = undefined;
      const next = await getApproval(id).catch(() => null);
      if (next === null) return ondone();
      prompt = next;
    } catch (err) {
      error = (err as Error).message;
    } finally {
      password = "";
      busy = false;
    }
  }

  /** The assets the request's chain names, and the main chain's coin (Deposits and Withdrawal payouts). */
  const assets = $derived(chains.find((c) => prompt && "chain" in prompt && c.chain === prompt.chain)?.assets ?? []);
  const coinAssets = $derived(chains.find((c) => c.id === "l1")?.assets ?? []);
  /**
   * An amount of the request's chain, as named by its Chain Entry or the asset store (saying which,
   * with its id); an unnamed asset says its id.
   */
  function amount(a: AssetAmount): string {
    const entry = assets.find((n) => n.id === a.asset);
    const text = amountText(a.amount, a.asset, assets);
    if (entry === undefined) return `${text} (Unknown asset ${shortAsset(a.asset)})`;
    const source = assetSource(entry);
    return source ? `${text} (${source}, ${shortAsset(a.asset)})` : text;
  }
  /** What to call each asset the request itself issues, by id: the new asset and its token. */
  function issuedAssetLabels(view: ClearView): Map<string, string> {
    const labels = new Map<string, string>();
    for (const { issuance } of view.inputs) {
      if (issuance === undefined) continue;
      labels.set(issuance.asset.asset, "New asset");
      if (issuance.token) labels.set(issuance.token.asset, "Reissuance token");
    }
    return labels;
  }
  /** Slots by their chains' names ("Elements+"), as the Chain Entries name them. */
  const chainNames = (slots: number[]) => slots.map((s) => chains.find((c) => c.id === s)?.name ?? `Slot ${s}`).join(", ");
  /** Sats of the main chain's coin. */
  const coin = (sats: string | number) => amountText(String(sats), "", coinAssets);

  const SIGHASH_NAMES: Record<number, string> = {
    0x02: "NONE",
    0x03: "SINGLE",
    0x81: "ALL|ANYONECANPAY",
    0x82: "NONE|ANYONECANPAY",
    0x83: "SINGLE|ANYONECANPAY",
  };

  /** A dangerous mode, in words. The Chain Module reports it as data; the words are the app's. */
  function describe(mode: DangerousMode, view: ClearView): string {
    if (mode.kind === "deposit" || mode.kind === "firstDeposit") {
      const output = view.outputs.find((o) => o.index === mode.output);
      const d = output?.destination.kind === "deposit" ? output.destination : undefined;
      const slot = d ? `Slot ${d.slot}${d.credit ? ` (${d.credit.chainName})` : ""}` : "a Slot";
      if (mode.kind === "firstDeposit") {
        return (
          `${slot} has no Treasury on the main chain's server, so this is its first Deposit. The wallet can't confirm the Slot is active ` +
          "and that it has no Treasury yet: if either is wrong, the funds can be lost. If someone else's first Deposit is pending, " +
          "the main chain refuses this one, or drops it once the other confirms, and its coins come back."
        );
      }
      return (
        `This is a Deposit to ${slot}: the funds leave the main chain, and only come back through a Withdrawal, a BIP300 miner vote ` +
        "of about 3 to 6 months. Crediting it on the sidechain isn't automatic: it waits for the chain's operator to import it."
      );
    }
    if (mode.kind === "nonDefaultSighash") {
      const name = SIGHASH_NAMES[mode.sighash] ?? "non-standard";
      return (
        `Input ${mode.input} is signed with sighash ${name} (0x${mode.sighash.toString(16)}), not the default ALL: ` +
        "your signature won't cover the whole transaction, so others could change parts of it after you sign."
      );
    }
    const output = view.outputs.find((o) => o.index === mode.output);
    const burn = output ? amount(output) : "funds";
    const payout =
      output?.destination.kind === "withdrawal"
        ? ` If the withdrawal is accepted, ${coin(output.destination.payout)} is paid on L1 (after a ${coin(output.destination.parentFee)} parent fee).`
        : "";
    return (
      `Output ${mode.output} is a withdrawal burn of ${burn}: it is irreversible. The burned funds leave this sidechain at once, ` +
      `but the L1 withdrawal takes months (the BIP300 miner vote runs about 3 to 6 months), and acceptance doesn't guarantee payment.${payout}`
    );
  }

  /** Requester labels for outputs the Clear View doesn't have (shown, tagged, but attached to nothing). */
  function strayLabels(view: ClearView, labels: Record<string, string> | undefined): [string, string][] {
    const indexes = new Set(view.outputs.map((o) => String(o.index)));
    return Object.entries(labels ?? {}).filter(([k]) => !indexes.has(k));
  }
</script>

{#snippet requester(origin: string, chain?: string)}
  <div class="card requester">
    <span class="muted small">Requested by</span>
    <strong class="origin" data-origin>{origin}</strong>
    {#if chain}<span class="chain">on <code class="chip" data-chain>{chain}</code></span>{/if}
  </div>
{/snippet}

{#if prompt === undefined}
  <main class="screen">
    <p class="loading"><span class="spinner"></span>Loading…</p>
  </main>
{:else if prompt === null}
  <main class="screen" data-approval-ready data-approval-missing>
    <div class="card centered">
      <h1>Request no longer pending</h1>
      <p class="muted">This request was already answered or has expired. You can close this window.</p>
    </div>
  </main>
{:else if prompt.kind === "connect"}
  <main class="screen" data-approval-ready>
    <div class="title">
      <h1>Grant request</h1>
      <p class="muted small">This site asks for a Grant to use your wallet:</p>
    </div>
    {@render requester(prompt.origin)}

    <section class="card">
      <h2>Sidechains (Slots)</h2>
      <ul class="chips">
        {#each prompt.slots as slot (slot)}
          <li class="chip" data-slot>{slot}</li>
        {/each}
      </ul>
      <h2>It will be allowed to ask for</h2>
      <ul class="chips">
        {#each prompt.methods as method (method)}
          <li class="chip" data-method>{method}</li>
        {/each}
      </ul>
    </section>

    {#if prompt.turnsOn?.length}
      <p class="notice" data-turns-on>
        <Icon name="plus" /><span>Approving also turns on {chainNames(prompt.turnsOn)}, which you have off, so it shows in your wallet.</span>
      </p>
    {/if}
    <p class="notice"><Icon name="shield" /><span>It will not be able to sign anything without asking you each time.</span></p>

    <label class="opt-in" class:on={blindOptIn}>
      <input type="checkbox" bind:checked={blindOptIn} data-blind-opt-in />
      <span>
        Also allow <strong>Blind Signing</strong>: asking you to sign requests the wallet can't explain.
        Leave this off unless you trust this site completely.
      </span>
    </label>

    <div class="decision">
      <button data-reject disabled={busy} onclick={() => decide(false)}>Reject</button>
      <button class={blindOptIn ? "danger-button" : "primary"} data-approve disabled={busy} onclick={() => decide(true)}>
        Approve Grant
      </button>
    </div>
  </main>
{:else if prompt.kind === "turnOn"}
  <main class="screen" data-approval-ready data-turn-on>
    <div class="title">
      <h1>Turn on {chainNames(prompt.slots)}?</h1>
      <p class="muted small">This site asks to use a chain you have off:</p>
    </div>
    {@render requester(prompt.origin)}
    <p class="notice">
      <Icon name="plus" />
      <span>Turning it on shows it in your wallet and lets the wallet read it from its server. You can turn it off again in Chains.</span>
    </p>
    <div class="decision">
      <button data-reject disabled={busy} onclick={() => decide(false)}>Keep it off</button>
      <button class="primary" data-approve disabled={busy} onclick={() => decide(true)}>Turn on</button>
    </div>
  </main>
{:else if prompt.kind === "unlock"}
  <main class="screen" data-approval-ready data-unlock-required>
    <div class="title">
      <h1>Unlock to review a request</h1>
      <p class="muted small">This site sent a Signing Request. Unlock your wallet to see it. Nothing is signed until you approve it.</p>
    </div>
    {@render requester(prompt.origin, prompt.chain)}
    <form class="card" onsubmit={unlock}>
      <label>
        Password
        <input type="password" autocomplete="current-password" bind:value={password} data-password />
      </label>
      <button class="primary block" type="submit" disabled={busy} data-unlock><Icon name="lock" size={16} /> Unlock</button>
    </form>
    {#if error}<p class="error" role="alert" data-error>{error}</p>{/if}
  </main>
{:else if prompt.kind === "suggestAsset"}
  {@const a = prompt.asset}
  {@const checked = a.source === "contract"}
  {@const b = prompt.balance}
  <!-- The balance in the suggested ticker and precision: what approving would show. -->
  {@const as = { id: a.id, ticker: a.ticker, name: a.name, decimals: a.precision }}
  <main class="screen" data-approval-ready data-suggest-asset>
    <div class="title">
      <h1>Name an asset</h1>
      <p class="muted small">This site suggests a name for an asset, for your wallet to show:</p>
    </div>
    {@render requester(prompt.origin, prompt.chain)}
    <section class="card stack">
      <div><strong data-suggested-ticker>{a.ticker}</strong> <span class="muted" data-suggested-name>{a.name}</span></div>
      <div class="small">{a.precision} decimal places</div>
      <code class="tiny full-id" data-suggested-id>{a.id}</code>
      <div class="small" data-suggested-balance>
        {#if "locked" in b}
          <span class="muted">Your balance isn't shown while the wallet is locked.</span>
        {:else if "error" in b}
          <span class="muted">Couldn't read your balance: {b.error}</span>
        {:else}
          You hold {amountText(b.amount, a.id, [as])}{#if b.unconfirmed !== "0"}, +{amountText(b.unconfirmed, a.id, [as])} unconfirmed{/if}.
        {/if}
      </div>
      {#if checked}
        <span class="badge ok" data-suggested-checked><Icon name="check" size={14} /> Its contract, checked against the chain</span>
        <p class="muted small">
          This is the contract the asset was issued with. The issuer chose its name.
          {#if a.domain}Claims the domain <code>{a.domain}</code> (not checked by this wallet).{/if}
        </p>
      {:else}
        <span class="badge" data-suggested-unchecked>Not checked: only this site's word</span>
        <p class="muted small">The asset has no contract here, so nothing backs this name. It will show as named by this site.</p>
      {/if}
    </section>
    {#if prompt.replaces}
      {@const r = prompt.replaces}
      <p class="notice" data-suggested-replaces>
        <Icon name="warning" /><span>Replaces its current name, {r.ticker} ({r.name}), {assetSource(r)}.</span>
      </p>
    {/if}
    <div class="decision">
      <button data-reject disabled={busy} onclick={() => decide(false)}>Reject</button>
      <button class="primary" data-approve disabled={busy} onclick={() => decide(true)}>Name it {a.ticker}</button>
    </div>
  </main>
{:else if prompt.kind === "sign" && prompt.decoded.kind === "clear"}
  {@const view = prompt.decoded.view}
  {@const labels = prompt.hints?.outputLabels ?? {}}
  {@const dangerous = view.dangerousModes.length > 0}
  {@const issuances = view.inputs.flatMap((i) => (i.issuance ? [i.issuance] : []))}
  {@const contractAssets = issuances.flatMap((i) =>
    i.contract ? [{ id: i.asset.asset, ticker: i.contract.ticker, name: i.contract.name, decimals: i.contract.precision }] : [],
  )}
  {@const shownAssets = [...assets, ...contractAssets]}
  {@const issuedLabels = issuedAssetLabels(view)}
  <main class="screen" data-approval-ready data-clear-view>
    {#if dangerous}
      <section class="danger-box" role="alert">
        <h2><Icon name="warning" /> Dangerous</h2>
        <ul class="stack">
          {#each view.dangerousModes as mode, i (i)}<li data-dangerous-mode>{describe(mode, view)}</li>{/each}
        </ul>
      </section>
    {/if}

    <div class="title">
      <h1>Signing Request</h1>
      <span class="badge ok"><Icon name="check" size={14} /> Clear View: decoded by this wallet</span>
    </div>
    {@render requester(prompt.origin, prompt.chain)}

    {#each issuances as issuance (issuance.asset.asset)}
      <section class="card stack" data-issuance>
        <h2>Creates a new asset</h2>
        <div data-issued-asset>
          {#if issuance.contract}
            {formatAllDecimals(issuance.asset.amount, issuance.contract.precision, issuance.contract.ticker)} ({issuance.contract.name}), new asset
          {:else}
            {amountText(issuance.asset.amount, issuance.asset.asset, assets)} base units of new asset
          {/if}
          <code title={issuance.asset.asset}>{shortAsset(issuance.asset.asset)}</code>
        </div>
        {#if issuance.token}
          <div data-issued-token>
            {amountText(issuance.token.amount, issuance.token.asset, assets)} base units of its reissuance token
            <code title={issuance.token.asset}>{shortAsset(issuance.token.asset)}</code>.
            <span class="muted small">This wallet's tokens are unblinded, so they can't issue more of the asset.</span>
          </div>
        {/if}
        {#if issuance.contract}
          {@const c = issuance.contract}
          <div class="small" data-contract>
            Its contract, checked against the hash it commits to: {c.name} ({c.ticker}), {c.precision} decimal places. The issuer chose these.
            Claims the domain <code>{c.domain}</code> (not checked by this wallet).
          </div>
          {#if c.issuerYours}
            <span class="badge ok" data-issuer-yours><Icon name="check" size={14} /> Issuer key: yours</span>
          {:else}
            <span class="badge" data-issuer-not-yours>Issuer key: not yours</span>
          {/if}
        {/if}
        <div class="small" data-contract-hash>
          {#if issuance.contractHash}Contract hash <code>{issuance.contractHash}</code>{:else}No contract{/if}
        </div>
        {#if !issuance.contract}
          <p class="muted small">The amount is in base units: the asset's precision is in its contract, which the request didn't include.</p>
        {/if}
      </section>
    {/each}

    <section class="stack">
      <h2>Outputs</h2>
      <ol class="stack">
        {#each view.outputs as output (output.index)}
          <li class="card output" data-output>
            <div class="output-head">
              {#if output.destination.kind === "deposit"}
                <span class="amount" data-deposit-amount>{coin(output.destination.deposit)}</span>
              {:else}
                {@const entry = assets.find((n) => n.id === output.asset)}
                {@const named = entry !== undefined}
                <span class="amount">{amountText(output.amount, output.asset, shownAssets)}<AssetBadge {entry} size={14} /></span>
                {#if assetSource(entry)}
                  <span class="muted small" data-asset-source>{assetSource(entry)} <code title={output.asset}>{shortAsset(output.asset)}</code></span>
                {:else if !named}
                  <span class="muted small">{issuedLabels.get(output.asset) ?? "Unknown asset"} <code title={output.asset}>{shortAsset(output.asset)}</code></span>
                {/if}
              {/if}
              <span class="index muted small">Output {output.index}</span>
            </div>
            {#if output.destination.kind === "address"}
              <div class="small">to <code data-destination>{output.destination.address}</code></div>
              {#if output.destination.yours}
                <span class="badge ok" data-yours><Icon name="check" size={14} /> Yours (verified by this wallet)</span>
              {:else}
                <span class="badge" data-not-yours>Not yours</span>
              {/if}
            {:else if output.destination.kind === "deposit"}
              {@const d = output.destination}
              <div class="small" data-deposit>
                Deposit {coin(d.deposit)} to Slot {d.slot}{d.credit ? ` (${d.credit.chainName})` : ""}.
                {#if d.credit}
                  {coin(d.deposit)} credited to <code data-destination>{d.credit.address}</code> after {d.credit.confirmations} blocks,
                  {d.credit.paidBy === "chain" ? `in a block of ${d.credit.chainName}'s own.` : "once the operator imports it."}
                {:else}
                  Credited to <code data-destination>{d.text ?? d.data}</code>.
                {/if}
              </div>
              <div class="muted small" data-treasury>
                Slot {d.slot}'s Treasury: {coin(d.treasuryBefore)} → {coin(output.amount)} (output {output.index}, its address in output {d.dataOutput})
              </div>
              {#if d.credit?.yours}
                <span class="badge ok" data-yours><Icon name="check" size={14} /> Credited to you (verified by this wallet)</span>
              {:else}
                <span class="badge bad" data-not-yours>Not credited to you</span>
              {/if}
            {:else}
              <div class="small">
                {#if output.destination.l1Address !== undefined}
                  Withdrawal burn to L1 address <code data-destination>{output.destination.l1Address}</code>,
                {:else}
                  Withdrawal burn to a non-standard L1 script (hex) <code data-destination>{output.destination.l1ScriptPubkey}</code>,
                {/if}
                paying {coin(output.destination.payout)} after a {coin(output.destination.parentFee)} parent fee
              </div>
              <span class="badge bad" data-not-yours>Not yours: burned</span>
            {/if}
            {#if labels[String(output.index)] !== undefined}
              <p class="reported" data-hint-label>Reported by {prompt.origin}: {labels[String(output.index)]}</p>
            {/if}
          </li>
        {/each}
      </ol>
    </section>

    <dl class="card facts">
      <dt>Fee</dt>
      <dd data-fee>{amount(view.fee)}</dd>
      <dt>Inputs</dt>
      <dd>
        {#each view.inputs as input (input.index)}
          <div data-input>
            Input {input.index}: {amount(input)}
            {input.treasury !== undefined
              ? `(Slot ${input.treasury}'s Treasury: spent and recreated)`
              : input.yours
                ? "(yours: you sign it)"
                : "(not yours)"}
          </div>
        {/each}
      </dd>
    </dl>

    {#if prompt.hints?.summary}
      <p class="reported" data-hint-summary>Reported by {prompt.origin}: {prompt.hints.summary}</p>
    {/if}
    {#each strayLabels(view, prompt.hints?.outputLabels) as [key, label] (key)}
      <p class="reported" data-hint-stray-label>Reported by {prompt.origin}: output {key}: {label}</p>
    {/each}

    <div class="decision">
      <button data-reject disabled={busy} onclick={() => decide(false)}>Reject</button>
      <button class={dangerous ? "danger-button" : "primary"} data-approve disabled={busy} onclick={() => decide(true)}>Sign</button>
    </div>
  </main>
{:else if prompt.kind === "sign" && prompt.decoded.kind === "blind"}
  {@const facts = prompt.decoded.verifiableFacts}
  {@const leaving = facts.totalLeaving.filter((a) => BigInt(a.amount) > 0n)}
  {@const comingIn = facts.totalLeaving.filter((a) => BigInt(a.amount) < 0n).map((a) => ({ ...a, amount: a.amount.slice(1) }))}
  <main class="screen" data-approval-ready data-blind>
    <div class="blind-banner" role="alert">
      <h1><Icon name="eye_off" size={24} /> Blind Signing</h1>
      <p>The wallet <strong>can't show you what this request does.</strong> {prompt.decoded.reason}</p>
      <p>Only approve if you trust this site completely and expected this request.</p>
    </div>

    {#if facts.dangerousFlags.length > 0}
      <section class="danger-box">
        <h2><Icon name="warning" /> Dangerous</h2>
        <ul class="stack">
          {#each facts.dangerousFlags as flag (flag)}<li data-dangerous-flag>{flag}</li>{/each}
        </ul>
      </section>
    {/if}

    {@render requester(prompt.origin, prompt.chain)}

    <section class="stack">
      <h2>What the wallet can prove</h2>
      <dl class="card facts">
        <dt>Your inputs it will sign</dt>
        <dd>
          {#each facts.ownedInputs as input (input.index)}
            <div data-owned-input>Input {input.index}: {amount(input)}</div>
          {:else}<div>None</div>{/each}
        </dd>
        <dt>Total leaving your wallet</dt>
        <dd>
          {#each leaving as a (a.asset)}<div data-total-leaving>{amount(a)}</div>{:else}<div>Nothing</div>{/each}
        </dd>
        {#if comingIn.length > 0}
          <dt>Coming into your wallet</dt>
          <dd>{#each comingIn as a (a.asset)}<div data-coming-in>{amount(a)}</div>{/each}</dd>
        {/if}
        <dt>Fee</dt>
        <dd>{#each facts.fee as a (a.asset)}<div data-fee>{amount(a)}</div>{:else}<div>None stated</div>{/each}</dd>
        {#if facts.unknownFields.length > 0}
          <dt>Fields the wallet doesn't understand</dt>
          <dd>
            <ul>{#each facts.unknownFields as field (field)}<li data-unknown-field><code>{field}</code></li>{/each}</ul>
          </dd>
        {/if}
      </dl>
    </section>

    {#if prompt.hints?.summary}
      <p class="reported" data-hint-summary>Reported by {prompt.origin}: {prompt.hints.summary}</p>
    {/if}
    {#each Object.entries(prompt.hints?.outputLabels ?? {}) as [key, label] (key)}
      <p class="reported" data-hint-stray-label>Reported by {prompt.origin}: output {key}: {label}</p>
    {/each}

    <div class="decision">
      <button data-reject disabled={busy} onclick={() => decide(false)}>Reject</button>
      <button class="danger-button" data-approve disabled={busy} onclick={() => decide(true)}>Sign blindly</button>
    </div>
  </main>
{/if}

<style>
  .full-id {
    overflow-wrap: anywhere;
  }
  .title {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 6px;
  }
  .centered {
    align-items: center;
    text-align: center;
  }
  .requester {
    gap: 4px;
  }
  .chain {
    display: flex;
    align-items: center;
    gap: 6px;
    font-weight: 600;
  }
  .chain .chip {
    font-size: 0.9rem;
    font-weight: 700;
    color: var(--text);
  }
  .opt-in {
    flex-direction: row;
    gap: 10px;
    padding: 12px;
    border: 1px solid var(--danger-border);
    border-radius: var(--radius-sm);
    font-weight: 400;
  }
  .opt-in.on {
    border: 2px solid var(--danger);
    background: var(--danger-bg);
  }
  .blind-banner {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin: -16px -16px 0;
    padding: 20px 16px;
    background: var(--danger-solid);
    color: var(--on-danger);
  }
  .blind-banner h1 {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 1.5rem;
  }
  .output {
    gap: 8px;
  }
  .output-head {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: 4px 8px;
  }
  .amount {
    font-size: 1.25rem;
  }
  .index {
    margin-left: auto;
  }
  .facts {
    gap: 2px;
    font-size: 0.9rem;
  }
  .facts dt {
    color: var(--muted);
    font-size: 0.8rem;
  }
  .facts dt:not(:first-child) {
    margin-top: 10px;
  }
  .facts dd {
    overflow-wrap: anywhere;
  }
</style>
