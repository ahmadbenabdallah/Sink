import type { H3Event } from 'h3'
import { parseAcceptLanguage } from 'intl-parse-accept-language'
import { UAParser } from 'ua-parser-js'
import {
  CLIs,
  Crawlers,
  Emails,
  ExtraDevices,
  Fetchers,
  InApps,
  MediaPlayers,
  Vehicles,
} from 'ua-parser-js/extensions'
import { parseURL } from 'ufo'
import { getFlag } from '#shared/utils/flag'

function toBlobNumber(blob: string) {
  return +blob.replace(/\D/g, '')
}

export const blobsMap = {
  blob1: 'slug',
  blob2: 'url',
  blob3: 'ua',
  blob4: 'ip',
  blob5: 'referer',
  blob6: 'country',
  blob7: 'region',
  blob8: 'city',
  blob9: 'timezone',
  blob10: 'language',
  blob11: 'os',
  blob12: 'browser',
  blob13: 'browserType',
  blob14: 'device',
  blob15: 'deviceType',
  blob16: 'COLO',
} as const

export const doublesMap = {
  double1: 'latitude',
  double2: 'longitude',
} as const

export type BlobsMap = typeof blobsMap
export type BlobsKey = keyof BlobsMap

export type DoublesMap = typeof doublesMap
export type DoublesKey = keyof DoublesMap

export type LogsKey = BlobsMap[BlobsKey] | DoublesMap[DoublesKey]
export type LogsMap = {
  [key in BlobsMap[BlobsKey]]: string | undefined
} & {
  [key in DoublesMap[DoublesKey]]?: number | undefined
}

export interface WebhookClickContext {
  country: string
  region: string
  city: string
  device: string
  browser: string
  os: string
  referer: string
}

export interface AccessLogResult {
  logs: LogsMap
  click: WebhookClickContext
}

export const logsMap = Object.fromEntries([
  ...Object.entries(blobsMap).map(([k, v]) => [v, k]),
  ...Object.entries(doublesMap).map(([k, v]) => [v, k]),
]) as LogsMap

export function logs2blobs(logs: LogsMap) {
  return (Object.keys(blobsMap) as BlobsKey[])
    .sort((a, b) => toBlobNumber(a) - toBlobNumber(b))
    .map(key => String(logs[blobsMap[key] as LogsKey] || ''))
}

export function blobs2logs(blobs: string[]) {
  const logsList = Object.keys(blobsMap)

  return blobs.reduce((logs, blob, i) => {
    const key = blobsMap[logsList[i] as BlobsKey]
    logs[key] = blob
    return logs
  }, {} as Partial<LogsMap>)
}

export function logs2doubles(logs: LogsMap) {
  return (Object.keys(doublesMap) as DoublesKey[])
    .sort((a, b) => toBlobNumber(a) - toBlobNumber(b))
    .map(key => Number(logs[doublesMap[key] as LogsKey] || 0))
}

export function doubles2logs(doubles: number[]) {
  const logsList = Object.keys(doublesMap)

  return doubles.reduce((logs, double, i) => {
    const key = doublesMap[logsList[i] as DoublesKey]
    logs[key] = double
    return logs
  }, {} as Partial<LogsMap>)
}

/**
 * Caps on the visitor-controlled text fields, so padded headers (an Analytics
 * Engine record holds up to 16 KB) cannot grow the R2 archive with no limit.
 * Real values fit: browser, OS and device are read by ua-parser-js from the
 * first 500 characters anyway, a DNS host name is at most 253 characters, and
 * language tags are a few characters long.
 */
export const MAX_USER_AGENT_BYTES = 512
const MAX_REFERER_BYTES = 255
const MAX_LANGUAGE_BYTES = 64

/** Cuts `value` to at most `maxBytes` of UTF-8 without splitting a character. */
export function truncateUtf8(value: string, maxBytes: number): string {
  const encoded = new TextEncoder().encode(value)
  if (encoded.length <= maxBytes)
    return value
  let end = maxBytes
  // Step back over continuation bytes (10xxxxxx) to the start of a character.
  while (end > 0 && (encoded[end]! & 0xC0) === 0x80)
    end--
  return new TextDecoder().decode(encoded.subarray(0, end))
}

function getCountryName(country?: string): string {
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(country || 'WD') || 'Worldwide'
  }
  catch {
    return 'Worldwide'
  }
}

export function collectAccessLog(event: H3Event): AccessLogResult | undefined {
  const ip = getHeader(event, 'cf-connecting-ip') || getHeader(event, 'x-real-ip') || getRequestIP(event, { xForwardedFor: true })

  const { host } = parseURL(getHeader(event, 'referer'))
  const referer = host && truncateUtf8(host, MAX_REFERER_BYTES)

  const acceptLanguage = getHeader(event, 'accept-language') || ''
  const topLanguage = (parseAcceptLanguage(acceptLanguage) || [])[0]
  const language = topLanguage && truncateUtf8(topLanguage, MAX_LANGUAGE_BYTES)

  const userAgent = getHeader(event, 'user-agent') || ''
  const uaInfo = (new UAParser(userAgent, {

    // @ts-expect-error
    browser: [Crawlers.browser || [], CLIs.browser || [], Emails.browser || [], Fetchers.browser || [], InApps.browser || [], MediaPlayers.browser || [], Vehicles.browser || []].flat(),

    // @ts-expect-error
    device: [ExtraDevices.device || []].flat(),
  })).getResult()

  const { cloudflare } = event.context
  const { request: { cf } } = cloudflare
  const link = event.context.link || {}

  const isBot = cf?.botManagement?.verifiedBot
    || ['crawler', 'fetcher'].includes(uaInfo?.browser?.type || '')
    || ['spider', 'bot'].includes(uaInfo?.browser?.name?.toLowerCase() || '')

  const { disableBotAccessLog } = useRuntimeConfig(event)
  if (isBot && disableBotAccessLog) {
    console.log('bot access log disabled:', truncateUtf8(userAgent, MAX_USER_AGENT_BYTES))
    return
  }

  const countryName = getCountryName(cf?.country)
  const logs = {
    url: link.url,
    slug: link.slug,
    ua: truncateUtf8(userAgent, MAX_USER_AGENT_BYTES),
    ip,
    referer,
    country: cf?.country,
    region: `${getFlag(cf?.country)} ${[cf?.region, countryName].filter(Boolean).join(',')}`,
    city: `${getFlag(cf?.country)} ${[cf?.city, countryName].filter(Boolean).join(',')}`,
    timezone: cf?.timezone,
    language,
    os: uaInfo?.os?.name,
    browser: uaInfo?.browser?.name,
    browserType: uaInfo?.browser?.type,
    device: uaInfo?.device?.model,
    deviceType: uaInfo?.device?.type,
    COLO: cf?.colo,

    // For RealTime Globe
    latitude: Number(cf?.latitude || getHeader(event, 'cf-iplatitude') || 0),
    longitude: Number(cf?.longitude || getHeader(event, 'cf-iplongitude') || 0),
  }

  return {
    logs,
    click: {
      country: cf?.country || '',
      region: cf?.region || '',
      city: cf?.city || '',
      device: uaInfo?.device?.type || uaInfo?.device?.model || '',
      browser: uaInfo?.browser?.name || '',
      os: uaInfo?.os?.name || '',
      referer: referer || '',
    },
  }
}

export function writeAccessLog(event: H3Event, accessLogs: LogsMap): void {
  const { cloudflare } = event.context
  const link = event.context.link || {}

  if (process.env.NODE_ENV === 'production') {
    const analytics = cloudflare.env.ANALYTICS
    if (!analytics)
      return

    analytics.writeDataPoint({
      indexes: [link.id], // only one index
      blobs: logs2blobs(accessLogs),
      doubles: logs2doubles(accessLogs),
    })
    return
  }

  console.log('access logs:', accessLogs)
}
