<script lang="ts">
  import "../app.css";
  import { reportActivity } from "$lib/activity";
  import { currentView } from "$lib/view";

  let { children } = $props();

  $effect(reportActivity);
  // app.css sizes the page by where it shows.
  $effect(() => {
    document.documentElement.dataset.view = currentView();
  });
</script>

{@render children()}
