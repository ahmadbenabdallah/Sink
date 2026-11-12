import type { ConnectorListResponse, ConnectorView } from '../../shared/types/connector'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useConnectors } from '../../app/composables/useConnectors'

const { useAPIMock } = vi.hoisted(() => ({
  useAPIMock: vi.fn(),
}))

vi.mock('@/utils/api', () => ({ useAPI: useAPIMock }))

function connector(overrides: Partial<ConnectorView> = {}): ConnectorView {
  return { id: 'c1', name: 'Claude Code', hint: 'abc123', level: 'read', createdAt: 1_800_000_000, revokedAt: null, lastUsedAt: null, calls7d: 0, ...overrides }
}

function listResponse(overrides: Partial<ConnectorListResponse> = {}): ConnectorListResponse {
  return {
    connectors: [connector()],
    reserved: [{ id: 'site-token', lastUsedAt: 1_800_000_500, calls7d: 12 }],
    dailyCallLimit: 5000,
    ...overrides,
  }
}

describe('useConnectors', () => {
  beforeEach(() => {
    useAPIMock.mockReset()
  })

  it('starts empty and not loaded', () => {
    const state = useConnectors()
    expect(state.connectors.value).toEqual([])
    expect(state.reserved.value).toEqual([])
    expect(state.dailyCallLimit.value).toBeNull()
    expect(state.loaded.value).toBe(false)
    expect(state.loading.value).toBe(false)
    expect(state.loadError.value).toBeNull()
  })

  it('loads the list, the reserved callers and the daily limit', async () => {
    useAPIMock.mockResolvedValueOnce(listResponse())
    const state = useConnectors()

    const loading = state.load()
    expect(state.loading.value).toBe(true)
    await loading

    expect(useAPIMock).toHaveBeenCalledExactlyOnceWith('/api/connector/list')
    expect(state.connectors.value).toEqual([connector()])
    expect(state.reserved.value).toEqual([{ id: 'site-token', lastUsedAt: 1_800_000_500, calls7d: 12 }])
    expect(state.dailyCallLimit.value).toBe(5000)
    expect(state.loaded.value).toBe(true)
    expect(state.loading.value).toBe(false)
  })

  // A failed refresh must not empty a list that is already on screen.
  it('keeps what it had and records the error when a load fails', async () => {
    const failure = new Error('network down')
    useAPIMock.mockResolvedValueOnce(listResponse()).mockRejectedValueOnce(failure)
    const state = useConnectors()
    await state.load()

    await state.load()

    expect(state.loadError.value).toBe(failure)
    expect(state.connectors.value).toEqual([connector()])
    expect(state.loading.value).toBe(false)
  })

  it('clears an earlier error once a load succeeds', async () => {
    useAPIMock.mockRejectedValueOnce(new Error('network down')).mockResolvedValueOnce(listResponse())
    const state = useConnectors()
    await state.load()
    expect(state.loadError.value).not.toBeNull()
    expect(state.loaded.value).toBe(false)

    await state.load()

    expect(state.loadError.value).toBeNull()
    expect(state.loaded.value).toBe(true)
  })

  it('creates a connector, puts it first, and hands back the token without keeping it', async () => {
    const created = connector({ id: 'c2', name: 'Cursor', level: 'full' })
    useAPIMock.mockResolvedValueOnce(listResponse()).mockResolvedValueOnce({ connector: created, token: 'sink_mcp_the-token' })
    const state = useConnectors()
    await state.load()

    const result = await state.create({ name: 'Cursor', level: 'full' })

    expect(useAPIMock).toHaveBeenLastCalledWith('/api/connector/create', { method: 'POST', body: { name: 'Cursor', level: 'full' } })
    expect(result).toEqual({ connector: created, token: 'sink_mcp_the-token' })
    expect(state.connectors.value.map(row => row.id)).toEqual(['c2', 'c1'])
    // The token is shown once by whoever asked for it; the state must not hold it.
    expect(JSON.stringify(state.connectors.value)).not.toContain('sink_mcp_the-token')
  })

  it('lets a failed create reach the caller and leaves the list alone', async () => {
    useAPIMock.mockResolvedValueOnce(listResponse()).mockRejectedValueOnce(new Error('preview mode'))
    const state = useConnectors()
    await state.load()

    await expect(state.create({ name: 'Cursor', level: 'full' })).rejects.toThrow('preview mode')
    expect(state.connectors.value).toEqual([connector()])
  })

  it('revokes a connector and marks it revoked in place', async () => {
    useAPIMock
      .mockResolvedValueOnce(listResponse({ connectors: [connector({ id: 'c2' }), connector({ id: 'c1', calls7d: 7 })] }))
      .mockResolvedValueOnce({ id: 'c1', revokedAt: 1_800_000_900 })
    const state = useConnectors()
    await state.load()

    await state.revoke('c1')

    expect(useAPIMock).toHaveBeenLastCalledWith('/api/connector/revoke', { method: 'POST', body: { id: 'c1' } })
    expect(state.connectors.value.map(row => [row.id, row.revokedAt, row.calls7d])).toEqual([
      ['c2', null, 0],
      ['c1', 1_800_000_900, 7],
    ])
  })

  it('lets a failed revoke reach the caller and leaves the connector active', async () => {
    useAPIMock.mockResolvedValueOnce(listResponse()).mockRejectedValueOnce(new Error('not found'))
    const state = useConnectors()
    await state.load()

    await expect(state.revoke('c1')).rejects.toThrow('not found')
    expect(state.connectors.value[0]!.revokedAt).toBeNull()
  })
})
