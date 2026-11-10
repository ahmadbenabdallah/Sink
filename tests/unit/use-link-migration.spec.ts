import type { LinkMigrationStatus } from '../../shared/schemas/link-migration'
import { createPinia, defineStore, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readonly, ref, shallowRef } from 'vue'
import { useLinkMigration } from '../../app/composables/useLinkMigration'

const { useAPIMock, cache } = vi.hoisted(() => ({
  useAPIMock: vi.fn(),
  cache: { current: undefined as unknown },
}))

vi.mock('#imports', () => ({ defineStore }))
vi.mock('@vueuse/core', () => ({ useLocalStorage: () => cache.current }))

const completedStatus: LinkMigrationStatus = {
  completed: true,
  marker: { version: 1, completedAt: '2026-11-01T00:00:00.000Z', scanned: 3, inserted: 3, skipped: 0, expired: 0 },
}
const pendingStatus: LinkMigrationStatus = { completed: false, marker: null }

describe('useLinkMigration status cache', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    useAPIMock.mockReset()
    vi.stubGlobal('useAPI', useAPIMock)
    vi.stubGlobal('ref', ref)
    vi.stubGlobal('shallowRef', shallowRef)
    vi.stubGlobal('readonly', readonly)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('shows a cached completed status at once and still asks the server', async () => {
    cache.current = ref<LinkMigrationStatus | null>(completedStatus)
    useAPIMock.mockResolvedValue(completedStatus)
    const migration = useLinkMigration()

    await migration.refreshStatus()

    expect(migration.completed.value).toBe(true)
    expect(useAPIMock).toHaveBeenCalledWith('/api/link/migration/status')
  })

  it('drops a cached completed status when the server says migration is not complete', async () => {
    const cached = ref<LinkMigrationStatus | null>(completedStatus)
    cache.current = cached
    useAPIMock.mockResolvedValue(pendingStatus)
    const migration = useLinkMigration()

    await migration.refreshStatus()
    await vi.waitFor(() => expect(migration.completed.value).toBe(false))

    expect(cached.value).toBeNull()
  })

  it('keeps the cached completed status when the server cannot be reached', async () => {
    const cached = ref<LinkMigrationStatus | null>(completedStatus)
    cache.current = cached
    useAPIMock.mockRejectedValue(new TypeError('Failed to fetch'))
    const migration = useLinkMigration()

    await migration.refreshStatus()
    await vi.waitFor(() => expect(useAPIMock).toHaveBeenCalled())

    expect(migration.completed.value).toBe(true)
    expect(migration.error.value).toBeNull()
    expect(cached.value).toEqual(completedStatus)
  })
})
