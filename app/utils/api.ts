import type { NitroFetchOptions, NitroFetchRequest } from 'nitropack'
import { getAuthToken, removeAuthToken } from '@/utils/auth-token'
import { getHttpErrorStatus } from '@/utils/http-error'

type APIOptions = Omit<NitroFetchOptions<NitroFetchRequest>, 'headers'> & {
  headers?: Record<string, string>
}

export function useAPI<T = unknown>(api: string, options?: APIOptions): Promise<T>
export async function useAPI(api: string, options?: APIOptions): Promise<unknown> {
  const { headers, ...fetchOptions } = options ?? {}
  const requestOptions: NitroFetchOptions<NitroFetchRequest> = {
    ...fetchOptions,
    headers: {
      'Authorization': `Bearer ${getAuthToken() ?? ''}`,
      'X-Requested-With': 'XMLHttpRequest',
      ...headers,
    },
  }

  try {
    return await $fetch(api, requestOptions)
  }
  catch (error: unknown) {
    if (getHttpErrorStatus(error) === 401) {
      removeAuthToken()
      if (import.meta.client && window.location.pathname !== '/dashboard/login')
        window.location.assign('/dashboard/login')
    }
    throw error
  }
}
