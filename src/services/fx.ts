// USD/EUR -> BRL exchange rates, refreshed at most once an hour from a free endpoint.
// On failure the last good rate is kept; before the first success there is no rate.

const FX_URL = "https://open.er-api.com/v6/latest/USD";
const TTL_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;

export interface FxRates {
  usdBrl: number;
  eurBrl: number;
  fetchedAt: number;
}

let rates: FxRates | null = null;
let inflight: Promise<FxRates | null> | null = null;

async function refresh(): Promise<FxRates | null> {
  try {
    const res = await fetch(FX_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const brl = Number(data?.rates?.BRL);
    const eur = Number(data?.rates?.EUR);
    if (!(brl > 0) || !(eur > 0)) throw new Error("rates missing from response");
    rates = { usdBrl: brl, eurBrl: brl / eur, fetchedAt: Date.now() };
    console.log(`[FX] USD->BRL ${brl.toFixed(4)}, EUR->BRL ${rates.eurBrl.toFixed(4)}`);
  } catch (err) {
    console.warn(`[FX] refresh failed (${(err as Error).message}), keeping ${rates ? "last rate" : "no rate"}`);
  }
  return rates;
}

/** Returns the cached rates, awaiting the first fetch; stale rates are refreshed in the background. */
export async function getRates(): Promise<FxRates | null> {
  const stale = !rates || Date.now() - rates.fetchedAt > TTL_MS;
  if (stale && !inflight) {
    inflight = refresh().finally(() => (inflight = null));
  }
  if (!rates && inflight) await inflight;
  return rates;
}

/** Converts an amount in USD or EUR to BRL, or null when no rate is available yet. */
export async function toBrl(amount: number | null | undefined, currency: "USD" | "EUR"): Promise<number | null> {
  if (amount == null) return null;
  const r = await getRates();
  if (!r) return null;
  const rate = currency === "EUR" ? r.eurBrl : r.usdBrl;
  return Math.round(amount * rate * 100) / 100;
}

// warm the cache at boot so the first scanned card already has a BRL value
void getRates();
