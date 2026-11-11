// Test fixture for `semgrep --test .semgrep/rules`. Not part of the app.
declare function fetchPublicHttpUrl(url: string, init?: RequestInit): Promise<Response>
declare const $fetch: <T = unknown>(url: string) => Promise<T>
declare const ofetch: (<T = unknown>(url: string) => Promise<T>) & { raw: (url: string) => Promise<Response> }
declare const handler: { fetch: (request: Request) => Promise<Response> }

export async function bad(url: string) {
  // ruleid: sink-no-raw-fetch-in-server
  return await fetch(url)
}

export async function badWithInit(url: string) {
  // ruleid: sink-no-raw-fetch-in-server
  return await fetch(url, { redirect: 'follow' })
}

export async function badGlobalThis(url: string) {
  // ruleid: sink-no-raw-fetch-in-server
  return await globalThis.fetch(url)
}

export async function badNuxtFetch(url: string) {
  // ruleid: sink-no-raw-fetch-in-server
  return await $fetch(url)
}

export async function badOfetch(url: string) {
  // ruleid: sink-no-raw-fetch-in-server
  return await ofetch(url)
}

export async function badOfetchTyped(url: string) {
  // ruleid: sink-no-raw-fetch-in-server
  return await ofetch<{ ok: boolean }>(url)
}

export async function badNuxtFetchTyped(url: string) {
  // ruleid: sink-no-raw-fetch-in-server
  return await $fetch<{ ok: boolean }>(url)
}

export async function badOfetchRaw(url: string) {
  // ruleid: sink-no-raw-fetch-in-server
  return await ofetch.raw(url)
}

export async function badInjectedFallback(url: string, fetcher?: typeof fetch) {
  // ruleid: sink-no-raw-fetch-in-server
  return await (fetcher || fetch)(url)
}

export async function good(url: string) {
  // ok: sink-no-raw-fetch-in-server
  return await fetchPublicHttpUrl(url)
}

export async function goodMethodCall(request: Request) {
  // ok: sink-no-raw-fetch-in-server
  return await handler.fetch(request)
}
