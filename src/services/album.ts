import { Database } from "bun:sqlite";

export interface CardInput {
  name: string;
  set?: string | null;
  number?: string | null;
  image?: string | null;
  currency?: string | null;
  prices?: { low?: number | null; mid?: number | null; high?: number | null; market?: number | null } | null;
  finish?: string | null; // "holofoil" | "reverse" | "normal"
  variant?: string | null; // TCGPlayer price key used ("holofoil", "reverseHolofoil", "normal", "cardmarket")
  brl?: number | null; // market price converted to BRL
}

export interface CardRow {
  id: number;
  key: string;
  name: string;
  set: string;
  number: string;
  image: string | null;
  currency: string;
  prices: { low: number | null; mid: number | null; high: number | null; market: number | null };
  finish: string | null;
  variant: string | null;
  brl: number | null;
  added_at: string;
}

interface DbRow {
  id: number;
  key: string;
  name: string;
  set_name: string | null;
  number: string | null;
  image: string | null;
  currency: string | null;
  market: number | null;
  low: number | null;
  mid: number | null;
  high: number | null;
  finish: string | null;
  variant: string | null;
  brl: number | null;
  added_at: string;
}

const db = new Database(process.env.ALBUM_DB ?? "album.db", { create: true });
// another process may hold the file mid-recovery (two dev servers restarting together); wait instead of throwing
db.exec("PRAGMA busy_timeout = 5000");
db.exec("PRAGMA journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS cards (
    id INTEGER PRIMARY KEY,
    key TEXT UNIQUE,
    name TEXT,
    set_name TEXT,
    number TEXT,
    image TEXT,
    currency TEXT,
    market REAL,
    low REAL,
    mid REAL,
    high REAL,
    finish TEXT,
    variant TEXT,
    brl REAL,
    added_at TEXT
  )
`);

// databases created before these columns existed get them added in place
const existing = new Set(db.query<{ name: string }, []>("PRAGMA table_info(cards)").all().map((c) => c.name));
for (const [col, type] of [["finish", "TEXT"], ["variant", "TEXT"], ["brl", "REAL"]]) {
  if (!existing.has(col)) db.exec(`ALTER TABLE cards ADD COLUMN ${col} ${type}`);
}

const selectAll = db.query<DbRow, []>("SELECT * FROM cards ORDER BY id");
const selectByKey = db.query<DbRow, [string]>("SELECT * FROM cards WHERE key = ?");
const insert = db.query<
  DbRow,
  [string, string, string, string, string | null, string, number | null, number | null, number | null, number | null, string | null, string | null, number | null, string]
>(
  `INSERT OR IGNORE INTO cards (key, name, set_name, number, image, currency, market, low, mid, high, finish, variant, brl, added_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`
);
const del = db.query<unknown, [number]>("DELETE FROM cards WHERE id = ?");

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function toRow(r: DbRow): CardRow {
  return {
    id: r.id,
    key: r.key,
    name: r.name,
    set: r.set_name ?? "",
    number: r.number ?? "",
    image: r.image,
    currency: r.currency ?? "USD",
    prices: { low: r.low, mid: r.mid, high: r.high, market: r.market },
    finish: r.finish ?? null,
    variant: r.variant ?? null,
    brl: r.brl ?? null,
    added_at: r.added_at,
  };
}

export function cardKey(card: Pick<CardInput, "name" | "number">): string {
  return `${card.name}||${card.number ?? ""}`;
}

export function listCards(): CardRow[] {
  return selectAll.all().map(toRow);
}

/** Inserts the card; returns `{ row, created }`. Duplicates (same name+number) return the existing row. */
export function addCard(card: CardInput): { row: CardRow; created: boolean } {
  const key = cardKey(card);
  const inserted = insert.get(
    key,
    card.name,
    card.set ?? "",
    card.number ?? "",
    card.image ?? null,
    card.currency ?? "USD",
    num(card.prices?.market),
    num(card.prices?.low),
    num(card.prices?.mid),
    num(card.prices?.high),
    card.finish ?? null,
    card.variant ?? null,
    num(card.brl),
    new Date().toISOString()
  );
  if (inserted) return { row: toRow(inserted), created: true };
  return { row: toRow(selectByKey.get(key)!), created: false };
}

export function removeCard(id: number): boolean {
  return del.run(id).changes > 0;
}

export function clear(): void {
  db.exec("DELETE FROM cards");
}

function csvCell(v: unknown): string {
  const s = v == null ? "" : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: CardRow[] = listCards()): string {
  const lines = ["name,set,number,market,currency,added_at"];
  for (const r of rows) {
    lines.push([r.name, r.set, r.number, r.prices.market ?? "", r.currency, r.added_at].map(csvCell).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}
