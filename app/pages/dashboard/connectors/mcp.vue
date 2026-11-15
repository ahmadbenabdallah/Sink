<script setup lang="ts">
definePageMeta({
  layout: 'dashboard',
})
</script>

<template>
  <main class="space-y-6">
    <h1 class="sr-only">
      {{ $t('nav.mcp_connectors') }}
    </h1>
    <DashboardConnectors />
  </main>
</template>
