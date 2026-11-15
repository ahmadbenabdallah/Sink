<script setup lang="ts">
import { Info } from '@lucide/vue'
import { summarizeHistory } from '@/utils/analysis-history'

const analysisStore = useDashboardAnalysisStore()
const summary = computed(() => summarizeHistory(Object.values(analysisStore.history)))
</script>

<template>
  <Alert v-if="summary.fromRollups || summary.missingDays || summary.recentOnly || summary.budgetReached">
    <Info aria-hidden="true" />
    <AlertDescription>
      <p v-if="summary.fromRollups">
        {{ $t('dashboard.analysis.history_daily') }}
      </p>
      <p v-if="summary.missingDays">
        {{ $t('dashboard.analysis.history_missing', { count: summary.missingDays }) }}
      </p>
      <p v-if="summary.recentOnly">
        {{ $t('dashboard.analysis.history_recent_only') }}
      </p>
      <p v-if="summary.budgetReached">
        {{ $t('dashboard.analysis.history_budget') }}
      </p>
    </AlertDescription>
  </Alert>
</template>
