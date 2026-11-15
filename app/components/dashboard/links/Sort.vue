<script setup lang="ts">
import type { DashboardLinkSort } from '@/utils/dashboard-query'
import { ArrowUpDown } from '@lucide/vue'
import { DATE_SORTS, LINK_SORTS, TRAFFIC_SORTS } from '@/utils/dashboard-query'

const linksStore = useDashboardLinksStore()

const groups = [
  { id: 'links-sort-date', label: 'links.sort.group_date', sorts: DATE_SORTS },
  { id: 'links-sort-traffic', label: 'links.sort.group_traffic', sorts: TRAFFIC_SORTS },
] as const

function select(value: unknown) {
  if ((LINK_SORTS as readonly unknown[]).includes(value))
    linksStore.sortBy = value as DashboardLinkSort
}
</script>

<template>
  <DropdownMenu>
    <DropdownMenuTrigger as-child>
      <Button
        variant="outline"
        :aria-label="$t('links.sort.label', { current: $t(`links.sort.${linksStore.sortBy}`) })"
      >
        <ArrowUpDown
          aria-hidden="true"
          class="
            size-4
            sm:mr-2
          "
        />
        <span
          class="
            hidden
            sm:inline
          "
        >
          {{ $t(`links.sort.${linksStore.sortBy}`) }}
        </span>
      </Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent>
      <!--
        Two radio groups on one value, so the current choice is announced and
        each group is named by its label ("Traffic, last ~3 months").
      -->
      <template v-for="(group, index) in groups" :key="group.id">
        <DropdownMenuSeparator v-if="index > 0" />
        <DropdownMenuLabel :id="group.id" class="font-normal">
          {{ $t(group.label) }}
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup
          :model-value="linksStore.sortBy"
          :aria-labelledby="group.id"
          @update:model-value="select"
        >
          <DropdownMenuRadioItem v-for="sort in group.sorts" :key="sort" :value="sort">
            {{ $t(`links.sort.${sort}`) }}
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </template>
    </DropdownMenuContent>
  </DropdownMenu>
</template>
