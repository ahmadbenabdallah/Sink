import type { McpLevel } from '../../shared/types/auth'
import type { ConnectorCreateResponse, ConnectorListResponse, ConnectorRemoveResponse, ConnectorRenameResponse, ConnectorRevokeResponse, ConnectorRotateResponse, ConnectorView, ReservedCallerView } from '../../shared/types/connector'
import { ref, shallowRef } from 'vue'
import { useAPI } from '@/utils/api'

/**
 * The state of the Connectors page: the list as the server last gave it, kept
 * in step with what the page itself creates and revokes.
 *
 * A token is returned by `create` to whoever asked for it and is never stored
 * here: it is shown once and then gone.
 */
export function useConnectors() {
  const connectors = ref<ConnectorView[]>([])
  const reserved = ref<ReservedCallerView[]>([])
  const dailyCallLimit = shallowRef<number | null>(null)
  const loading = shallowRef(false)
  /** Whether a list has ever arrived. Until then there is nothing to show but a placeholder. */
  const loaded = shallowRef(false)
  const loadError = shallowRef<unknown>(null)

  /** Fetches the list. A failure is kept in `loadError` and leaves what is on screen as it was. */
  async function load(): Promise<void> {
    loading.value = true
    try {
      const response = await useAPI<ConnectorListResponse>('/api/connector/list')
      connectors.value = response.connectors
      reserved.value = response.reserved
      dailyCallLimit.value = response.dailyCallLimit
      loaded.value = true
      loadError.value = null
    }
    catch (error) {
      loadError.value = error
    }
    finally {
      loading.value = false
    }
  }

  /** Creates a connector and puts it at the top of the list. Throws what the request threw. */
  async function create(input: { name: string, level: McpLevel }): Promise<ConnectorCreateResponse> {
    const response = await useAPI<ConnectorCreateResponse>('/api/connector/create', { method: 'POST', body: input })
    connectors.value = [response.connector, ...connectors.value]
    return response
  }

  /** Revokes a connector and marks it revoked where it stands in the list. Throws what the request threw. */
  async function revoke(id: string): Promise<void> {
    const { revokedAt } = await useAPI<ConnectorRevokeResponse>('/api/connector/revoke', { method: 'POST', body: { id } })
    connectors.value = connectors.value.map(connector => connector.id === id ? { ...connector, revokedAt } : connector)
  }

  function replace(updated: ConnectorView) {
    connectors.value = connectors.value.map(connector => connector.id === updated.id ? updated : connector)
  }

  /** Renames a connector and replaces its row with the server's. Throws what the request threw. */
  async function rename(id: string, name: string): Promise<void> {
    const { connector } = await useAPI<ConnectorRenameResponse>('/api/connector/rename', { method: 'POST', body: { id, name } })
    replace(connector)
  }

  /** Replaces a connector's token. The new token goes back to the caller and is never kept here. */
  async function rotate(id: string): Promise<ConnectorRotateResponse> {
    const response = await useAPI<ConnectorRotateResponse>('/api/connector/rotate', { method: 'POST', body: { id } })
    replace(response.connector)
    return response
  }

  /** Removes a connector: it leaves the list for good. Throws what the request threw. */
  async function remove(id: string): Promise<void> {
    await useAPI<ConnectorRemoveResponse>('/api/connector/remove', { method: 'POST', body: { id } })
    connectors.value = connectors.value.filter(connector => connector.id !== id)
  }

  return { connectors, reserved, dailyCallLimit, loading, loaded, loadError, load, create, revoke, rename, rotate, remove }
}
