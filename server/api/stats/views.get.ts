export default eventHandler(async (event) => {
  const query = await getValidatedQuery(event, ViewsQuerySchema.parse)
  const plan = historyPlan(query, Date.now())
  if (!plan)
    return useWAE(event, buildViewsQuery(query, event))
  if (query.unit !== 'day')
    return { ...await useWAE(event, buildViewsQuery(query, event)), history: recentOnlyHistory(plan) }
  return viewsWithHistory(event, plan, query, range => useWAE(event, buildViewsQuery({ ...query, ...range }, event)))
})
