import { afterAll, describe, expect, it, vi } from 'vitest'

// `defineAppConfig` is a Nuxt auto-import; outside Nuxt it only has to return its argument.
vi.stubGlobal('defineAppConfig', (config: unknown) => config)
const { default: appConfig } = await import('../../app/app.config')
// Test files share one global scope (`isolate: false`).
afterAll(() => vi.unstubAllGlobals())

describe('footer links', () => {
  it('point at the owner\'s profiles', () => {
    expect(appConfig.linkedin).toBe('https://linkedin.com/in/ahmed-benabdallah')
    expect(appConfig.website).toBe('https://ahmedbenabdallah.com')
  })

  // AGPL-3.0: a modified public service offers its own source, not upstream's.
  it('offer the source of this fork', () => {
    expect(appConfig.source).toBe('https://github.com/ahmadbenabdallah/Sink')
  })
})
