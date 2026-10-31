export type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };
type Reply = { status?: number; body?: unknown };
type Route = { method: string; match: string | RegExp; reply: Reply | ((call: Call) => Reply) };

/** A fetch stand-in that records calls and answers from a route table. */
export function mockFetch(routes: Route[]) {
  const calls: Call[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const headers = Object.fromEntries(Object.entries((init?.headers as Record<string, string>) ?? {}));
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const call = { url, method, headers, body };
    calls.push(call);

    const route = routes.find(
      (r) => r.method === method && (typeof r.match === "string" ? url.endsWith(r.match) || url.includes(r.match) : r.match.test(url)),
    );
    if (!route) throw new Error(`No mock route for ${method} ${url}`);
    const reply = typeof route.reply === "function" ? route.reply(call) : route.reply;
    const text = reply.body === undefined ? "" : JSON.stringify(reply.body);
    return new Response(text || null, { status: reply.status ?? 200 });
  };
  return { fetch: fetch as typeof globalThis.fetch, calls };
}
