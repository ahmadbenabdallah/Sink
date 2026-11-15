export default eventHandler(async (event) => {
  const query = await getValidatedQuery(event, HeatmapQuerySchema.parse)
  const result = await useWAE(event, buildHeatmapQuery(query, event))
  const plan = historyPlan(query, Date.now())
  return plan ? { ...result, history: recentOnlyHistory(plan) } : result
})
