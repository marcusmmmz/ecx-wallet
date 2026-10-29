<script lang="ts">
  import { page } from "$app/state";
  import { closeApproval } from "$platform";
  import Approval from "$lib/Approval.svelte";
</script>

<!-- Each request gets fresh prompt state, even when a web approval replaces this route. -->
{#key page.params.id}
  {@const id = page.params.id ?? ""}
  <Approval {id} ondone={() => { if (page.params.id === id) closeApproval(); }} />
{/key}
