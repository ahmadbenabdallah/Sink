/**
 * Some access-log dimensions hold text a visitor chose: the referer is whatever
 * followed `//` in the Referer header, the language is the first Accept-Language
 * entry, and the browser and operating system names are captured from the
 * User-Agent. The dashboard shows them to a person; an agent reads them as part
 * of its input, next to tools that change links.
 *
 * Before metric rows go to an agent, a value that does not have the shape its
 * dimension should have is replaced with a fixed label. This narrows what a
 * visitor can say to an agent; it does not make the remaining values trusted.
 * A referer made of words joined by dots is still a valid hostname and still
 * passes, as does any short browser or operating system name.
 * Stored analytics and the REST routes are not changed.
 */

interface MetricRow { name?: unknown, count?: unknown }

const HOST_LABEL = String.raw`\w(?:[\w-]{0,61}\w)?`
const REFERER_PATTERN = new RegExp(
  String.raw`^(?:(?=.{1,100}$)${HOST_LABEL}(?:\.${HOST_LABEL})*\.?|\[[0-9a-f:.]{2,45}\])(?::\d{1,5})?$`,
  'i',
)

const NAME_RULES: Record<string, { pattern: RegExp, label: string }> = {
  // DNS labels (1-63 characters, no leading or trailing hyphen) up to 100
  // characters in all, or a bracketed IPv6 literal; either with an optional port.
  referer: { pattern: REFERER_PATTERN, label: '(not a hostname)' },
  // Language with up to two subtags: `en`, `en-US`, `zh-Hant-TW`.
  language: { pattern: /^[a-z]{2,3}(?:-[a-z0-9]{2,8}){0,2}$/i, label: '(other)' },
  browser: { pattern: /^[\w .+-]{1,32}$/, label: '(other)' },
  os: { pattern: /^[\w .+-]{1,32}$/, label: '(other)' },
}

/**
 * Returns the rows with unexpected names replaced, adding up the counts of rows
 * that end up under the same label. Anything that is not a list of rows is
 * returned as is.
 */
export function sanitizeMetricRows<T>(type: string, rows: T): T {
  const rule = NAME_RULES[type]
  if (!rule || !Array.isArray(rows))
    return rows

  const result: MetricRow[] = []
  let replaced: MetricRow | undefined
  for (const row of rows as MetricRow[]) {
    if (typeof row?.name !== 'string' || row.name === '' || rule.pattern.test(row.name)) {
      result.push(row)
      continue
    }
    if (!replaced) {
      replaced = { ...row, name: rule.label, count: 0 }
      result.push(replaced)
    }
    const count = Number(row.count)
    if (Number.isFinite(count))
      replaced.count = Number(replaced.count) + count
  }
  return result as T
}
