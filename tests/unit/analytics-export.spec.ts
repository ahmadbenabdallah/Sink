import { describe, expect, it, vi } from 'vitest'
import { archiveKey, createLineCounter, eligibleDays, hourWindow } from '../../server/utils/analytics-export'

vi.mock('#shared/utils/flag', () => ({ getFlag: vi.fn() }))

const NOW = Date.UTC(2026, 10, 14, 0, 2) // 2026-11-14 00:02 UTC

describe('eligibleDays', () => {
  it('lists full UTC days from 85 to 2 days old, oldest first', () => {
    const days = eligibleDays(NOW)
    expect(days[0]).toBe('2026-08-21')
    expect(days.at(-1)).toBe('2026-11-12')
    expect(days).toHaveLength(84)
    expect([...days].sort()).toEqual(days)
  })

  it('never includes yesterday or today, whose late records may still arrive', () => {
    expect(eligibleDays(NOW)).not.toContain('2026-11-13')
    expect(eligibleDays(NOW)).not.toContain('2026-11-14')
  })

  it('uses UTC day boundaries, not the time of day', () => {
    expect(eligibleDays(Date.UTC(2026, 10, 14, 23, 59))).toEqual(eligibleDays(NOW))
    expect(eligibleDays(Date.UTC(2026, 10, 15, 0, 0)).at(-1)).toBe('2026-11-13')
  })
})

describe('hourWindow', () => {
  it('covers one UTC hour as [start, end) in unix seconds', () => {
    expect(hourWindow('2026-08-21', 0)).toEqual({ start: Date.UTC(2026, 7, 21) / 1000, end: Date.UTC(2026, 7, 21, 1) / 1000 })
    expect(hourWindow('2026-08-21', 23).end).toBe(Date.UTC(2026, 7, 22) / 1000)
  })
})

describe('archiveKey', () => {
  it('names one file per day and hour', () => {
    expect(archiveKey('2026-08-21', 0)).toBe('analytics/raw/2026-08-21/00.ndjson')
    expect(archiveKey('2026-08-21', 23)).toBe('analytics/raw/2026-08-21/23.ndjson')
  })
})

describe('createLineCounter', () => {
  async function count(chunks: string[]) {
    const counter = createLineCounter()
    const encoder = new TextEncoder()
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks)
          controller.enqueue(encoder.encode(chunk))
        controller.close()
      },
    })
    const passed = await new Response(source.pipeThrough(counter.stream)).text()
    return { passed, ...counter.result() }
  }

  it('passes the bytes through unchanged and counts newline bytes across chunk boundaries', async () => {
    const result = await count(['{"a":1}\n{"a', '":2}\n', '{"a":3}\n'])
    expect(result.passed).toBe('{"a":1}\n{"a":2}\n{"a":3}\n')
    expect(result.lines).toBe(3)
    expect(result.endsWithNewline).toBe(true)
  })

  it('reports a body cut off before its final newline', async () => {
    const result = await count(['{"a":1}\n{"a":2}'])
    expect(result.lines).toBe(1)
    expect(result.endsWithNewline).toBe(false)
  })

  it('reports an empty body', async () => {
    expect(await count([])).toMatchObject({ lines: 0, endsWithNewline: false })
  })
})
