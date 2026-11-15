import { QuerySchema } from '#shared/schemas/query'

export default eventHandler(async (event) => {
  const query = await getValidatedQuery(event, QuerySchema.parse)
  const plan = historyPlan(query, Date.now())
  if (!plan)
    return useWAE(event, buildCountersQuery(query, event))
  return countersWithHistory(event, plan, query, range => useWAE(event, buildCountersQuery({ ...query, ...range }, event)))
})
