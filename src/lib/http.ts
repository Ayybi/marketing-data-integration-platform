// NEW: a tiny injectable HTTP seam so every connector can be tested deterministically without network
// (inject a fake Fetcher) while production uses global fetch. The three-state read discipline lives in
// each connector on top of this: a transport throw or a non-2xx is surfaced/counted, never a silent 0.
export type HttpInit = { method?: string; headers?: Record<string, string>; timeoutMs?: number; body?: string }

export type HttpResponse = {
  status: number
  ok: boolean
  text(): Promise<string>
  json(): Promise<unknown>
}

export type Fetcher = (url: string, init?: HttpInit) => Promise<HttpResponse>

export const defaultFetcher: Fetcher = async (url, init = {}) => {
  const res = await fetch(url, {
    method: init.method,
    headers: init.headers,
    body: init.body,
    signal: init.timeoutMs ? AbortSignal.timeout(init.timeoutMs) : undefined,
  })
  return {
    status: res.status,
    ok: res.ok,
    text: () => res.text(),
    json: () => res.json() as Promise<unknown>,
  }
}
