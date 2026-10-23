// End-to-end regression test for the Pokemon card scanner.
// Usage (server must already be running on :3002, or on $PORT):  bun scripts/e2e.ts
import { deflateSync } from "node:zlib";

const PORT = process.env.PORT ?? "3002";
const HTTP_URL = `http://localhost:${PORT}/`;
const WS_URL = `ws://localhost:${PORT}/ws`;
const REPLY_TIMEOUT_MS = 40_000;

const CARDS: { url: string; expected: string }[] = [
  { url: "https://images.pokemontcg.io/base1/4.png", expected: "Charizard" },
  { url: "https://images.pokemontcg.io/base1/2.png", expected: "Blastoise" },
  { url: "https://images.pokemontcg.io/base1/15.png", expected: "Venusaur" },
  { url: "https://images.pokemontcg.io/base1/58.png", expected: "Pikachu" },
  { url: "https://images.pokemontcg.io/base1/10.png", expected: "Mewtwo" },
  { url: "https://images.pokemontcg.io/base1/6.png", expected: "Gyarados" },
  { url: "https://images.pokemontcg.io/base1/16.png", expected: "Zapdos" },
  { url: "https://images.pokemontcg.io/base1/44.png", expected: "Bulbasaur" },
  { url: "https://images.pokemontcg.io/base1/46.png", expected: "Charmander" },
  { url: "https://images.pokemontcg.io/base1/63.png", expected: "Squirtle" },
];

type ServerMsg =
  | { type: "hello"; boot?: unknown }
  | { type: "maybe"; name: string }
  | {
      type: "card";
      name: string;
      set?: string;
      number?: string;
      image?: string;
      currency?: string;
      prices?: { low?: number | null; mid?: number | null; high?: number | null; market?: number | null };
      finish?: string | null;
      variant?: string | null;
      brl?: number | null;
    }
  | { type: "no_card" }
  | { type: "error"; message?: string };

interface Row {
  expected: string;
  returned: string;
  vision: string; // name from the first `maybe` (what the vision model read)
  gotCard: boolean;
  hasMarket: boolean;
  seconds: number;
  replies: string;
}

// ---------- WebSocket helper with a reply queue ----------
class Scanner {
  private ws!: WebSocket;
  private queue: ServerMsg[] = [];
  private waiter: ((m: ServerMsg) => void) | null = null;
  private closed = false;

  async connect(): Promise<void> {
    this.ws = new WebSocket(WS_URL);
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("WebSocket connect timeout")), 10_000);
      this.ws.onopen = () => {
        clearTimeout(t);
        resolve();
      };
      this.ws.onerror = (e) => {
        clearTimeout(t);
        reject(new Error("WebSocket error: " + String((e as any).message ?? e)));
      };
    });
    this.ws.onmessage = (ev) => {
      let msg: ServerMsg;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg.type === "hello") return; // ignore greeting
      if (this.waiter) {
        const w = this.waiter;
        this.waiter = null;
        w(msg);
      } else {
        this.queue.push(msg);
      }
    };
    this.ws.onclose = () => {
      this.closed = true;
    };
  }

  sendFrame(b64: string): void {
    this.ws.send(JSON.stringify({ type: "frame", data: b64 }));
  }

  sendConfirm(b64: string): void {
    this.ws.send(JSON.stringify({ type: "confirm", data: b64 }));
  }

  awaitReply(timeoutMs = REPLY_TIMEOUT_MS): Promise<ServerMsg> {
    if (this.queue.length) return Promise.resolve(this.queue.shift()!);
    if (this.closed) return Promise.reject(new Error("WebSocket closed"));
    return new Promise<ServerMsg>((resolve, reject) => {
      const t = setTimeout(() => {
        this.waiter = null;
        // Drop the socket so a late reply cannot be mistaken for the next step's answer;
        // ensureOpen() reconnects before the next message is sent.
        this.closed = true;
        this.close();
        reject(new Error(`timeout after ${timeoutMs / 1000}s`));
      }, timeoutMs);
      this.waiter = (m) => {
        clearTimeout(t);
        resolve(m);
      };
    });
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Reconnect if the server dropped the socket (e.g. after a timed-out frame). */
  async ensureOpen(): Promise<boolean> {
    if (!this.closed) return false;
    this.closed = false;
    this.queue = [];
    this.waiter = null;
    await this.connect();
    return true;
  }

  close(): void {
    try {
      this.ws.close();
    } catch {}
  }
}

// ---------- helpers ----------
async function fetchBase64(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} downloading ${url}`);
  return Buffer.from(await res.arrayBuffer()).toString("base64");
}

// Minimal PNG encoder for a solid-color RGB image (no deps).
function solidPng(width: number, height: number, rgb: [number, number, number]): Buffer {
  const crcTable = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c;
  }
  const crc32 = (buf: Buffer) => {
    let c = -1;
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const row = Buffer.alloc(1 + width * 3);
  row[0] = 0; // filter: none
  for (let x = 0; x < width; x++) {
    row[1 + x * 3] = rgb[0];
    row[2 + x * 3] = rgb[1];
    row[3 + x * 3] = rgb[2];
  }
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function describe(m: ServerMsg): string {
  switch (m.type) {
    case "maybe":
      return `maybe(${m.name})`;
    case "card":
      return `card(${m.name}, market=${m.prices?.market ?? "null"}, variant=${m.variant ?? "null"}, finish=${m.finish ?? "null"}, brl=${m.brl ?? "null"})`;
    case "error":
      return `error(${m.message ?? ""})`;
    default:
      return m.type;
  }
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

// ---------- main ----------
async function main() {
  // 1. Reachability check - never start a server ourselves.
  try {
    const r = await fetch(HTTP_URL, { signal: AbortSignal.timeout(5_000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
  } catch (e) {
    console.error(`Server at ${HTTP_URL} is unreachable (${(e as Error).message}). Start it first; aborting.`);
    process.exit(2);
  }

  const scanner = new Scanner();
  await scanner.connect();
  console.log(`Connected to ${WS_URL}\n`);

  const rows: Row[] = [];

  // 2. Ten real cards, two frames each.
  for (const { url, expected } of CARDS) {
    const t0 = performance.now();
    const replies: ServerMsg[] = [];
    let returned = "";
    let vision = "";
    let gotCard = false;
    let hasMarket = false;
    try {
      if (await scanner.ensureOpen()) console.log("  (socket was closed; reconnected)");
      const b64 = await fetchBase64(url);
      // Step 1: live-preview frame -> expect `maybe` (cheap detection).
      scanner.sendFrame(b64);
      const first = await scanner.awaitReply();
      replies.push(first);
      if (first.type === "maybe") {
        vision = first.name;
        returned = first.name;
        // Step 2: snapshot confirmation -> expect `card` (priced) or `no_card`.
        scanner.sendConfirm(b64);
        const second = await scanner.awaitReply();
        replies.push(second);
        if (second.type === "card") {
          gotCard = true;
          returned = second.name;
          hasMarket = second.prices?.market != null;
        }
      }
    } catch (e) {
      replies.push({ type: "error", message: (e as Error).message });
    }
    const seconds = (performance.now() - t0) / 1000;
    const row: Row = {
      expected,
      returned: returned || "-",
      vision: vision || "-",
      gotCard,
      hasMarket,
      seconds,
      replies: replies.map(describe).join(" -> "),
    };
    rows.push(row);
    console.log(`${pad(expected, 11)} ${row.replies}  (${seconds.toFixed(1)}s)`);
  }

  // 3. Non-card image (solid grey 600x800 PNG), two frames.
  console.log("\nNegative control: solid-color 600x800 PNG, frame (+ confirm if detected)");
  const noise = solidPng(600, 800, [120, 120, 120]).toString("base64");
  const negReplies: ServerMsg[] = [];
  let falsePositive = false; // any `maybe` or `card` for a non-card image
  let negCard = false; // a `card` came back after confirm
  const tNeg = performance.now();
  try {
    if (await scanner.ensureOpen()) console.log("  (socket was closed; reconnected)");
    scanner.sendFrame(noise);
    const first = await scanner.awaitReply();
    negReplies.push(first);
    if (first.type === "maybe" || first.type === "card") {
      falsePositive = true;
      if (first.type === "maybe") {
        scanner.sendConfirm(noise);
        const second = await scanner.awaitReply();
        negReplies.push(second);
        if (second.type === "card") negCard = true;
      } else {
        negCard = true;
      }
    }
  } catch (e) {
    negReplies.push({ type: "error", message: (e as Error).message });
  }
  console.log(`non-card    ${negReplies.map(describe).join(" -> ")}  (${((performance.now() - tNeg) / 1000).toFixed(1)}s)`);

  scanner.close();

  // 4. Table + summary.
  const W = {
    exp: 11,
    vis: Math.max(6, ...rows.map((r) => r.vision.length)),
    ret: Math.max(8, ...rows.map((r) => r.returned.length)),
    card: 5,
    mkt: 7,
    sec: 6,
    ok: 5,
  };
  const header =
    pad("Expected", W.exp) +
    " | " +
    pad("Vision", W.vis) +
    " | " +
    pad("Returned", W.ret) +
    " | " +
    pad("Card", W.card) +
    " | " +
    pad("Market", W.mkt) +
    " | " +
    pad("Secs", W.sec) +
    " | " +
    pad("Name", W.ok);
  console.log("\n" + header);
  console.log("-".repeat(header.length));
  let nameHits = 0;
  let visionHits = 0;
  let marketHits = 0;
  let totalSecs = 0;
  for (const r of rows) {
    const nameOk = r.returned.toLowerCase() === r.expected.toLowerCase();
    if (nameOk) nameHits++;
    if (r.vision.toLowerCase() === r.expected.toLowerCase()) visionHits++;
    if (r.hasMarket) marketHits++;
    totalSecs += r.seconds;
    console.log(
      pad(r.expected, W.exp) +
        " | " +
        pad(r.vision, W.vis) +
        " | " +
        pad(r.returned, W.ret) +
        " | " +
        pad(r.gotCard ? "yes" : "no", W.card) +
        " | " +
        pad(r.hasMarket ? "yes" : "no", W.mkt) +
        " | " +
        pad(r.seconds.toFixed(1), W.sec) +
        " | " +
        pad(nameOk ? "OK" : "MISS", W.ok)
    );
  }
  const n = rows.length;
  console.log("\nSummary");
  console.log(`  Name accuracy (case-insensitive exact): ${nameHits}/${n}`);
  console.log(`  Vision read matches expected (maybe):   ${visionHits}/${n}`);
  console.log(`  Cards with market price:                ${marketHits}/${n}`);
  console.log(
    `  No-card false positives:                ${falsePositive ? 1 : 0}` +
      (falsePositive ? ` (confirm returned card: ${negCard ? "yes" : "no"})` : "")
  );
  console.log(`  Average seconds per card:               ${(totalSecs / n).toFixed(1)}`);

  process.exit(nameHits === n && !falsePositive ? 0 : 1);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(2);
});
