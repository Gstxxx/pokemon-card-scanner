import type { Finish } from "./vision";

export interface CardPrice {
  id: string;
  name: string;
  set: string;
  number: string;
  image: string;
  currency: "USD" | "EUR";
  /** Finish the scanner saw on the physical card (what we asked for). */
  finish: Finish | null;
  /** Price variant actually used, e.g. "holofoil", "reverseHolofoil", "normal", "cardmarket". */
  variant: string | null;
  prices: { low: number | null; mid: number | null; high: number | null; market: number | null };
}

export interface PriceHints {
  finish?: Finish | null;
  /** Printed set size from "013/094" -> "94"; pins the exact set on pokemontcg.io. */
  printedTotal?: string;
}

const FETCH_TIMEOUT_MS = 8000;

// TCGPlayer variant keys in order of preference for each physical finish
const VARIANT_ORDER: Record<Finish, string[]> = {
  holofoil: ["holofoil", "1stEditionHolofoil", "unlimitedHolofoil", "reverseHolofoil", "normal", "1stEdition", "unlimited"],
  reverse: ["reverseHolofoil", "holofoil", "1stEditionHolofoil", "normal", "1stEdition", "unlimited"],
  normal: ["normal", "unlimited", "1stEdition", "holofoil", "1stEditionHolofoil", "reverseHolofoil"],
};
const DEFAULT_ORDER = ["holofoil", "normal", "reverseHolofoil", "1stEditionHolofoil", "1stEdition", "unlimited"];

export async function getCardPrice(
  name: string,
  set?: string,
  number?: string,
  hints: PriceHints = {}
): Promise<CardPrice | null> {
  const { finish = null, printedTotal } = hints;

  // name+number+total pins one card; if that fails, the set total alone narrows to one set (a
  // misread digit in the number is the most common vision slip), then number alone, then name
  let candidates: any[] = [];
  if (number && printedTotal) candidates = await searchPokemonTcg(name, number, printedTotal);
  if (candidates.length === 0 && printedTotal) candidates = await searchPokemonTcg(name, undefined, printedTotal);
  if (candidates.length === 0 && number) candidates = await searchPokemonTcg(name, number);
  if (candidates.length === 0) candidates = await searchPokemonTcg(name);

  const best = pickBest(candidates, name, number, set, finish, printedTotal);
  if (best) return fromPokemonTcg(best, finish);

  console.log(`pokemontcg.io gave nothing for "${name}", trying TCGdex`);
  return searchTcgdex(name, number, finish, printedTotal);
}

// Prefer the exact species name over variants ("Team Rocket's Mewtwo ex"), then the printed
// collector number and set size, then anything that actually has a market price
function pickBest(cards: any[], name: string, number?: string, set?: string, finish: Finish | null = null, printedTotal?: string) {
  const wanted = name.toLowerCase();
  const scored = cards.map((c) => {
    let score = 0;
    if (String(c.name).toLowerCase() === wanted) score += 4;
    if (number && String(c.number).toLowerCase() === number.toLowerCase()) score += 3;
    if (printedTotal && c.set?.printedTotal != null && String(c.set.printedTotal) === printedTotal) score += 3;
    if (set && c.set?.name && String(c.set.name).toLowerCase() === set.toLowerCase()) score += 2;
    if (extractPrices(c, finish)?.prices.market != null) score += 1;
    return { c, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.c ?? null;
}

// ---------- pokemontcg.io (primary) ----------

function fromPokemonTcg(card: any, finish: Finish | null): CardPrice {
  const p = extractPrices(card, finish);
  return {
    id: card.id,
    name: card.name,
    set: card.set?.name ?? "",
    number: card.number ?? "",
    image: card.images?.large ?? card.images?.small ?? "",
    currency: "USD",
    finish,
    variant: p?.variant ?? null,
    prices: {
      low: p?.prices.low ?? null,
      mid: p?.prices.mid ?? null,
      high: p?.prices.high ?? null,
      market: p?.prices.market ?? null,
    },
  };
}

// Picks the TCGPlayer price variant matching the physical finish, falling back to the others
export function extractPrices(card: any, finish: Finish | null = null): { variant: string; prices: any } | null {
  const p = card.tcgplayer?.prices;
  if (!p) return null;
  const order = finish ? VARIANT_ORDER[finish] : DEFAULT_ORDER;
  const isVariant = (k: string) => p[k] != null && typeof p[k] === "object";
  for (const key of order) {
    if (isVariant(key)) return { variant: key, prices: p[key] };
  }
  const any = Object.keys(p).find(isVariant);
  return any ? { variant: any, prices: p[any] } : null;
}

async function searchPokemonTcg(name: string, number?: string, printedTotal?: string): Promise<any[]> {
  let q = `name:"${name}"`;
  if (number) q += ` number:${number}`;
  if (printedTotal) q += ` set.printedTotal:${printedTotal}`;
  const url = `https://api.pokemontcg.io/v2/cards?q=${encodeURIComponent(q)}&pageSize=50&orderBy=-set.releaseDate`;

  for (let attempt = 0; attempt < 3; attempt++) {
    const headers: Record<string, string> = {};
    if (process.env.POKEMONTCG_API_KEY) headers["X-Api-Key"] = process.env.POKEMONTCG_API_KEY;
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }).catch(() => null);
    const data = res?.ok ? await res.json().catch(() => null) : null;
    if (data?.data) return data.data;
    await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
  }
  return [];
}

// ---------- TCGdex (fallback) ----------

async function searchTcgdex(name: string, number?: string, finish: Finish | null = null, printedTotal?: string): Promise<CardPrice | null> {
  const res = await fetch(`https://api.tcgdex.net/v2/en/cards?name=${encodeURIComponent(name)}`, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  }).catch(() => null);
  const list: any[] = res?.ok ? await res.json().catch(() => []) : [];
  if (list.length === 0) return null;

  const wanted = name.toLowerCase();
  const exact = list.filter((c) => String(c.name).toLowerCase() === wanted);
  const byNumber = number ? exact.filter((c) => String(c.localId).toLowerCase() === number.toLowerCase()) : [];
  const pool = byNumber.length ? byNumber : exact.length ? exact : list;
  const candidates = pool.slice(-8).reverse();

  // the list endpoint has no set info, so fetch details and score them like pickBest does
  let best: { card: CardPrice; score: number } | null = null;
  for (const c of candidates) {
    const d = await fetch(`https://api.tcgdex.net/v2/en/cards/${c.id}`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
    if (!d) continue;

    const tp = d.pricing?.tcgplayer;
    const picked = tp ? extractPrices({ tcgplayer: { prices: tp } }, finish) : null;
    const variant = picked?.prices ?? null;
    const cm = d.pricing?.cardmarket;

    const card: CardPrice = {
      id: d.id,
      name: d.name,
      set: d.set?.name ?? "",
      number: d.localId ?? "",
      image: d.image ? `${d.image}/high.webp` : "",
      currency: variant ? "USD" : "EUR",
      finish,
      variant: variant ? picked!.variant : cm ? "cardmarket" : null,
      prices: variant
        ? { low: variant.lowPrice ?? null, mid: variant.midPrice ?? null, high: variant.highPrice ?? null, market: variant.marketPrice ?? null }
        : { low: cm?.low ?? null, mid: cm?.avg ?? null, high: null, market: cm?.avg ?? cm?.trend ?? null },
    };

    let score = 0;
    const official = d.set?.cardCount?.official ?? d.set?.cardCount?.total;
    if (printedTotal && official != null && String(official) === printedTotal) score += 3;
    if (card.prices.market != null) score += 1;
    if (variant) score += 1; // TCGPlayer USD matches the primary source better than Cardmarket EUR
    if (!best || score > best.score) best = { card, score };
    if (score >= 5) break; // set pinned and priced in USD: nothing better to find
  }
  return best?.card ?? null;
}
