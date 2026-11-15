export default eventHandler(async (event) => {
  const query = await getValidatedQuery(event, MetricsQuerySchema.parse)
  const plan = historyPlan(query, Date.now())
  if (!plan)
    return useWAE(event, buildMetricsQuery(query, event))
  return metricsWithHistory(event, plan, query, range => useWAE(event, buildMetricsQuery({ ...query, ...range }, event)))
})
