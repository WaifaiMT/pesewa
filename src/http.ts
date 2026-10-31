import { PesewaError } from "./errors";

export type HttpOptions = {
  /** Custom fetch (for tests, proxies, or older runtimes). Defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Per-request timeout in milliseconds. Default 30000. */
  timeoutMs?: number;
};

export type HttpResponse = { status: number; data: unknown; text: string };

export async function request(
  provider: string,
  options: HttpOptions,
  url: string,
  init: { method: string; headers?: Record<string, string>; body?: unknown },
): Promise<HttpResponse> {
  const doFetch = options.fetch ?? globalThis.fetch;
  if (!doFetch) throw new PesewaError("invalid_request", "No fetch available; pass options.fetch or use Node.js 18+.");

  let response: Response;
  try {
    response = await doFetch(url, {
      method: init.method,
      headers: {
        Accept: "application/json",
        ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
    });
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    throw new PesewaError("network", timedOut ? `${provider} request timed out` : `Couldn't reach ${provider}`, {
      provider,
      raw: error,
    });
  }

  const text = await response.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (response.status === 401 || response.status === 403) {
    throw new PesewaError("authentication", `${provider} rejected the credentials`, {
      provider,
      httpStatus: response.status,
      raw: data,
    });
  }
  return { status: response.status, data, text };
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/** Reads headers from a Fetch Headers object or a plain Node-style object, case-insensitively. */
export function getHeader(headers: Headers | Record<string, string | string[] | undefined>, name: string): string | null {
  if (typeof (headers as Headers).get === "function") return (headers as Headers).get(name);
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers as Record<string, string | string[] | undefined>)) {
    if (key.toLowerCase() === wanted) return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
  }
  return null;
}
