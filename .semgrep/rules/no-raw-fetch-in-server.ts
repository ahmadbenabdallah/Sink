// Test fixture for `semgrep --test .semgrep/rules`. Not part of the app.
declare function fetchPublicHttpUrl(url: string, init?: RequestInit): Promise<Response>
declare const handler: { fetch: (request: Request) => Promise<Response> }

export async function bad(url: string) {
  // ruleid: sink-no-raw-fetch-in-server
  return await fetch(url)
}

export async function badWithInit(url: string) {
  // ruleid: sink-no-raw-fetch-in-server
  return await fetch(url, { redirect: 'follow' })
}

export async function good(url: string) {
  // ok: sink-no-raw-fetch-in-server
  return await fetchPublicHttpUrl(url)
}

export async function goodMethodCall(request: Request) {
  // ok: sink-no-raw-fetch-in-server
  return await handler.fetch(request)
}
