import { Channel, invoke } from "@tauri-apps/api/core";

interface ProxyHead {
  id: number;
  status: number;
  headers: [string, string][];
}

const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

/**
 * `fetch` that runs through `src-tauri/src/net.rs`: one pooled, kept-alive HTTP
 * client (no per-request TLS handshake, no CORS), with the body streamed back.
 */
export async function proxyFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const req = new Request(input, init);
  const signal = init?.signal ?? undefined;
  signal?.throwIfAborted();

  const body =
    init?.body == null ? undefined : typeof init.body === "string" ? init.body : await req.text();

  let id: number | undefined;
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start: (c) => void (controller = c),
    cancel: () => void (id !== undefined && invoke("proxy_abort", { id })),
  });

  const onBody = new Channel<ArrayBuffer>();
  onBody.onmessage = (chunk) => {
    const bytes = new Uint8Array(chunk);
    try {
      if (bytes.byteLength === 0) controller.close();
      else controller.enqueue(bytes);
    } catch {
      // Stream already closed or cancelled by the reader.
    }
  };

  const head = await invoke<ProxyHead>("proxy_fetch", {
    url: req.url,
    method: req.method,
    headers: [...req.headers],
    body,
    onBody,
  });
  id = head.id;

  const abort = () => {
    invoke("proxy_abort", { id });
    try {
      controller.error(new DOMException("Aborted", "AbortError"));
    } catch {}
  };
  if (signal?.aborted) {
    abort();
    throw new DOMException("Aborted", "AbortError");
  }
  signal?.addEventListener("abort", abort, { once: true });

  return new Response(NULL_BODY_STATUSES.has(head.status) ? null : stream, {
    status: head.status,
    headers: head.headers,
  });
}

/** Stand-in API key that `withKeyFailover` swaps for a real one per request. */
export const KEY_PLACEHOLDER = "__SOTTO_API_KEY__";
const RETRY_STATUSES = new Set([401, 403, 429]);
const preferredKey = new Map<string, number>();

/**
 * Wraps `proxyFetch` so a provider can be configured with several comma-separated
 * keys. A key that's rejected or rate-limited falls through to the next one, and
 * the last working key is tried first next time.
 */
export function withKeyFailover(provider: string, keys: string[]): typeof fetch {
  return async (input, init) => {
    const start = preferredKey.get(provider) ?? 0;
    let last: Response | undefined;
    for (let i = 0; i < keys.length; i++) {
      const index = (start + i) % keys.length;
      const key = keys[index];
      const headers = new Headers(init?.headers);
      headers.forEach((value, name) => {
        if (value.includes(KEY_PLACEHOLDER)) headers.set(name, value.replaceAll(KEY_PLACEHOLDER, key));
      });
      const url = String(input instanceof Request ? input.url : input).replaceAll(KEY_PLACEHOLDER, encodeURIComponent(key));

      last = await proxyFetch(url, { ...init, headers });
      if (!RETRY_STATUSES.has(last.status) || i === keys.length - 1) {
        preferredKey.set(provider, index);
        return last;
      }
      await last.body?.cancel();
    }
    return last!;
  };
}

export const parseKeys = (value: string) =>
  value.split(",").map((k) => k.trim()).filter(Boolean);

/** Opens pooled connections ahead of time so the next request starts instantly. */
export const warm = (urls: string[]) => invoke("warm", { urls }).catch(() => {});
