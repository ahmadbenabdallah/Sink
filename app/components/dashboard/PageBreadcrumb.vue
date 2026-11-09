<script setup lang="ts">
import type { RouteLocationRaw } from 'vue-router'

defineProps<{
  title: string
  // Optional clickable middle level, e.g. Links on the link-detail page.
  parent?: { title: string, to: RouteLocationRaw }
}>()
</script>

<template>
  <Breadcrumb class="min-w-0">
    <BreadcrumbList class="min-w-0 flex-nowrap">
      <BreadcrumbItem class="shrink-0 whitespace-nowrap">
        <span class="text-muted-foreground">
          {{ $t('dashboard.title') }}
        </span>
      </BreadcrumbItem>
      <BreadcrumbSeparator class="shrink-0" />
      <template v-if="parent">
        <BreadcrumbItem class="shrink-0 whitespace-nowrap">
          <!-- as-child + NuxtLink: a plain href would reload the SPA and reset the list filters. -->
          <BreadcrumbLink as-child>
            <NuxtLink :to="parent.to">
              {{ parent.title }}
            </NuxtLink>
          </BreadcrumbLink>
        </BreadcrumbItem>
        <BreadcrumbSeparator class="shrink-0" />
      </template>
      <BreadcrumbItem class="min-w-0">
        <BreadcrumbPage class="block truncate whitespace-nowrap" :title="title">
          {{ title }}
        </BreadcrumbPage>
      </BreadcrumbItem>
    </BreadcrumbList>
  </Breadcrumb>
</template>
