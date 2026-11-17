<script setup lang="ts">
import type { NuxtError } from '#app'
import errorImage from './assets/images/404.svg?raw'

defineProps<{
  error: NuxtError
}>()
</script>

<template>
  <!-- ponytail: the new name shows here only for now; rename `title` in app.config to use it everywhere. -->
  <NuxtLayout name="default" brand="Shorteer">
    <section
      class="flex flex-1 flex-col items-center justify-center gap-6 px-6 py-16"
    >
      <h1 class="sr-only">
        {{ error.statusCode }} {{ error.statusMessage }}
      </h1>
      <NuxtLink
        class="
          flex w-full max-w-[600px] items-center justify-center rounded-2xl
          focus-visible:ring-2 focus-visible:ring-ring
          [&_svg]:h-auto [&_svg]:w-full
        "
        to="/"
        :aria-label="$t('layouts.links.home_aria_label')"
      >
        <span class="contents" v-html="errorImage" />
      </NuxtLink>
    </section>
  </NuxtLayout>
</template>

<style scoped>
@media (prefers-reduced-motion: reduce) {
  :deep(svg *) {
    animation: none !important;
  }
}
</style>
