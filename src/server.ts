import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { identifyCard } from "./services/vision";
import { getCardPrice, type PriceHints } from "./services/pricing";
import { toBrl, getRates } from "./services/fx";
import { matchPokemon } from "./services/pokedex";
import { upscale, isBlank } from "./services/upscale";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Server, WebSocketHandler } from "bun";
import QRCode from "qrcode";
import { lanIPv4Addresses } from "../scripts/gen-cert";
import { listCards, addCard, removeCard, toCsv } from "./services/album";

const BOOT = Date.now();
const app = new Hono();

// pokemontcg.io returns 5xx under concurrent bursts, so price lookups run one at a time
let priceQueue: Promise<unknown> = Promise.resolve();
function queuedPrice(name: string, set: string, number: string, hints: PriceHints = {}) {
  const next = priceQueue.then(() => getCardPrice(name, set, number, hints));
  priceQueue = next.catch(() => {});
  return next;
}

async function readName(base64: string) {
  const card = await identifyCard(base64);
  if (!card) return null;
  const name = await matchPokemon(card.name);
  console.log(`Read: "${card.name}" -> ${name ?? "not a pokemon"}`);
  return name ? { ...card, name } : null;
}

// ---------- album API (persistent collection, SQLite) ----------
app.get("/api/cards", (c) => c.json(listCards()));

app.get("/api/cards.csv", (c) =>
  c.body(toCsv(), 200, {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="album-${new Date().toISOString().slice(0, 10)}.csv"`,
  })
);

app.post("/api/cards", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }
  const card = body as Record<string, unknown>;
  if (!card || typeof card.name !== "string" || !card.name.trim()) {
    return c.json({ error: "name is required" }, 400);
  }
  const { row, created } = addCard({
    name: card.name.trim(),
    set: typeof card.set === "string" ? card.set : "",
    number: card.number == null ? "" : String(card.number),
    image: typeof card.image === "string" ? card.image : null,
    currency: typeof card.currency === "string" ? card.currency : "USD",
    prices: (card.prices as Record<string, number | null> | undefined) ?? null,
    finish: typeof card.finish === "string" ? card.finish : null,
    variant: typeof card.variant === "string" ? card.variant : null,
    brl: typeof card.brl === "number" ? card.brl : null,
  });
  return c.json({ ...row, created }, created ? 201 : 200);
});

app.delete("/api/cards/:id", (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) return c.json({ error: "Invalid id" }, 400);
  return removeCard(id) ? c.json({ ok: true, id }) : c.json({ error: "Not found" }, 404);
});

// ---------- phone access (HTTPS on the LAN, see scripts/gen-cert.ts) ----------
const CERT_DIR = join(import.meta.dir, "..", ".certs");
const KEY_PATH = join(CERT_DIR, "key.pem");
const CERT_PATH = join(CERT_DIR, "cert.pem");
const HAS_CERT = existsSync(KEY_PATH) && existsSync(CERT_PATH);
const HTTPS_PORT = parseInt(process.env.PORT_HTTPS ?? "3443");

function phoneUrls() {
  // httpsServer is assigned at startup below; empty until HTTPS is actually listening
  const port = httpsServer?.port;
  return port ? lanIPv4Addresses().map((ip) => `https://${ip}:${port}`) : [];
}

app.get("/api/phone", (c) => {
  const urls = phoneUrls();
  if (!urls.length) return c.json({ error: "HTTPS not enabled; run `bun scripts/gen-cert.ts`" }, 404);
  return c.json({ url: urls[0], urls });
});

app.get("/qr.svg", async (c) => {
  const [url] = phoneUrls();
  if (!url) return c.text("HTTPS not enabled; run `bun scripts/gen-cert.ts`", 404);
  const svg = await QRCode.toString(url, { type: "svg", margin: 1, color: { dark: "#151515", light: "#ffffff" } });
  return c.body(svg, 200, { "Content-Type": "image/svg+xml", "Cache-Control": "no-store" });
});

// current USD/EUR -> BRL rates (null until the first successful fetch) so the album can show R$
app.get("/api/fx", async (c) => c.json(await getRates()));

app.use("/*", serveStatic({ root: "./src/public" }));

// fetch/websocket handlers are shared by the HTTP and HTTPS servers below
function handleFetch(req: Request, server: Server<undefined>) {
  if (new URL(req.url).pathname === "/ws") {
    const upgraded = server.upgrade(req);
    if (upgraded) return undefined;
    return new Response("WebSocket upgrade failed", { status: 400 });
  }
  return app.fetch(req);
}

const websocket: WebSocketHandler<undefined> = {
    open(ws) {
      ws.send(JSON.stringify({ type: "hello", boot: BOOT }));
    },
    async message(ws, raw) {
      try {
        const msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));

        // live preview frame: cheap detection only, the client then snaps a photo to confirm
        if (msg.type === "frame") {
          if (await isBlank(msg.data)) {
            ws.send(JSON.stringify({ type: "no_card" }));
            return;
          }
          const card = await readName(msg.data);
          ws.send(JSON.stringify(card ? { type: "maybe", name: card.name } : { type: "no_card" }));
          return;
        }

        // snapshot confirmation: upscale, re-read at high resolution, then price it
        if (msg.type === "confirm") {
          console.log("Confirming snapshot...");
          const card = (await readName(await upscale(msg.data))) ?? (await readName(msg.data));
          if (!card) {
            ws.send(JSON.stringify({ type: "no_card" }));
            return;
          }

          const pricing = await queuedPrice(card.name, card.set, card.number, {
            finish: card.finish,
            printedTotal: card.printedTotal,
          });
          if (!pricing) {
            console.log(`"${card.name}" not in TCG database, ignoring`);
            ws.send(JSON.stringify({ type: "no_card" }));
            return;
          }

          ws.send(
            JSON.stringify({
              type: "card",
              name: pricing.name,
              set: pricing.set,
              number: pricing.number,
              image: pricing.image,
              currency: pricing.currency,
              prices: pricing.prices,
              finish: pricing.finish,
              variant: pricing.variant,
              brl: await toBrl(pricing.prices.market ?? pricing.prices.mid, pricing.currency),
            })
          );
        }
      } catch (err) {
        console.error("WebSocket message error:", err);
        ws.send(JSON.stringify({ type: "error", message: "Processing failed" }));
      }
    },
};

const server = Bun.serve({ port: parseInt(process.env.PORT ?? "3002"), fetch: handleFetch, websocket });

let httpsServer: Server<undefined> | null = null;
if (HAS_CERT) {
  try {
    httpsServer = Bun.serve({
      port: HTTPS_PORT,
      tls: { key: Bun.file(KEY_PATH), cert: Bun.file(CERT_PATH) },
      fetch: handleFetch,
      websocket,
    });
  } catch (err) {
    // e.g. another instance already on PORT_HTTPS; keep serving HTTP
    console.warn(`HTTPS off: could not listen on ${HTTPS_PORT} (${(err as Error).message})`);
  }
}

console.log(`Pokemon scanner running on http://localhost:${server.port}`);
for (const ip of lanIPv4Addresses()) console.log(`  http://${ip}:${server.port}`);
if (httpsServer) {
  console.log(`HTTPS (phone camera) on https://localhost:${httpsServer.port}`);
  for (const url of phoneUrls()) console.log(`  ${url}`);
} else if (!HAS_CERT) {
  console.log("HTTPS off: run `bun scripts/gen-cert.ts` to enable the phone camera");
}
