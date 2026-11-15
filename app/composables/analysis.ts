import type { AnalyticsHistory } from '#shared/types/analytics-history'
import type { AnalysisQueryState, AnalysisView, DashboardSlugFilters, HeatmapMetric } from '@/utils/dashboard-query'
import { ref } from 'vue'
import { defineStore, useI18n } from '#imports'
import { toSlugFilters } from '@/utils/dashboard-query'
import { computeDateRange } from '@/utils/time'

export const useDashboardAnalysisStore = defineStore('dashboard-analysis', () => {
  const { locale } = useI18n()
  const dateRange = ref({ startAt: 0, endAt: 0 })
  const datePreset = ref<AnalysisQueryState['datePreset']>('last-7d')
  const filters = ref<DashboardSlugFilters>({})
  const viewMode = ref<AnalysisView>('trend')
  const heatmapMetric = ref<HeatmapMetric>('visits')
  /** The `history` each part of the page last received, for the note about days older than three months. */
  const history = ref<Record<string, AnalyticsHistory | undefined>>({})

  function reportHistory(part: string, value: AnalyticsHistory | undefined) {
    history.value = { ...history.value, [part]: value }
  }

  function updateDateRange(range: [number, number]) {
    dateRange.value = { startAt: range[0], endAt: range[1] }
  }

  function selectPreset(name: NonNullable<AnalysisQueryState['datePreset']>) {
    datePreset.value = name
    updateDateRange(computeDateRange(name, locale.value))
  }

  function selectCustomRange(range: [number, number]) {
    datePreset.value = null
    updateDateRange(range)
  }

  function updateFilter(type: string, value: string) {
    if (type !== 'slug')
      return

    filters.value = toSlugFilters(value)
  }

  function clearFilters() {
    filters.value = {}
  }

  function applyRouteState(state: AnalysisQueryState) {
    datePreset.value = state.datePreset
    updateDateRange(state.datePreset
      ? computeDateRange(state.datePreset, locale.value)
      : state.dateRange ?? computeDateRange('last-7d', locale.value))
    filters.value = toSlugFilters(state.slugs)
    viewMode.value = state.view
    heatmapMetric.value = state.metric
  }

  return {
    dateRange,
    datePreset,
    filters,
    viewMode,
    heatmapMetric,
    history,
    reportHistory,
    updateDateRange,
    selectPreset,
    selectCustomRange,
    updateFilter,
    clearFilters,
    applyRouteState,
  }
})
