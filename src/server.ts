import { config } from "./config";
import { getRisk, saveRisk, loadRisk } from "./risk";
import { getLearn } from "./learn";
import type { Fill, Quote } from "./market";
import type { BlockEvent } from "./trader";

interface Meta { model: string; wallet: string | null; dryRun: boolean; market: string; startedAt: number }

const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET, POST, OPTIONS" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, "content-type": "application/json" } });

/** GET / snapshot · GET /history · GET /dashboard · GET /api/risk · POST /api/risk · GET /events SSE */
export function startServer(meta: Meta, history: () => BlockEvent[]) {
  const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const enc = new TextEncoder();
  const send = (c: ReadableStreamDefaultController<Uint8Array>, type: string, data: unknown) => {
    try { c.enqueue(enc.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`)); } catch { clients.delete(c); }
  };
  setInterval(() => clients.forEach((c) => send(c, "ping", Date.now())), 15_000);

  // init risk from file/env
  loadRisk();

  Bun.serve({
    port: config.port,
    hostname: "0.0.0.0",
    async fetch(req) {
      const { pathname } = new URL(req.url);
      if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
      if (pathname === "/") return json({ ...meta, latest: history().at(-1) ?? null, risk: getRisk() });
      if (pathname === "/history") return json(history());
      if (pathname === "/api/risk" && req.method === "GET") return json(getRisk());
      if (pathname === "/api/learning" && req.method === "GET") return json(getLearn());
      if (pathname === "/api/risk" && req.method === "POST") {
        try {
          const body = await req.json() as any;
          const latest = history().at(-1);
          const mid = latest?.mid ?? 0.0289;
          const saved = saveRisk(body, mid);
          return json({ ok: true, risk: saved });
        } catch (e) { return json({ ok: false, error: String(e) }, 400); }
      }
      if (pathname === "/dashboard" || pathname === "/app" || pathname === "/god") {
        const html = Bun.file(import.meta.dir + "/dashboard.html");
        return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", ...CORS } });
      }
      if (pathname === "/learn" || pathname === "/learning" || pathname === "/brain") {
        const html = Bun.file(import.meta.dir + "/learning.html");
        return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", ...CORS } });
      }
      if (pathname === "/events") {
        const stream = new ReadableStream<Uint8Array>({
          start(c) { clients.add(c); send(c, "snapshot", { ...meta, history: history() }); },
          cancel(c) { clients.delete(c); },
        });
        return new Response(stream, { headers: { ...CORS, "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" } });
      }
      return json({ error: "not found" }, 404);
    },
  });

  const broadcast = (type: string, data: unknown) => clients.forEach((c) => send(c, type, data));
  return {
    broadcast: (e: BlockEvent) => broadcast("block", e),
    /** A quote's receipt landed: placed (with order id) or reverted, and the real gas. */
    broadcastQuote: (block: number, quote: Quote) => broadcast("quote", { block, quote }),
    /** A taker hit one of our resting orders in `block`. */
    broadcastFill: (block: number, fill: Fill) => broadcast("fill", { block, fill }),
  };
}
