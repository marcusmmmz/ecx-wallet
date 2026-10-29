<script lang="ts">
  import { page } from "$app/state";
  import { closeApproval } from "$platform";
  import Approval from "$lib/Approval.svelte";
</script>

<!-- The approval window: one request's approval, which closes the window once answered. -->
<Approval id={page.params.id ?? ""} ondone={closeApproval} />
