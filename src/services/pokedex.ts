let names: string[] | null = null;

async function loadNames(): Promise<string[]> {
  if (names) return names;
  const res = await fetch("https://pokeapi.co/api/v2/pokemon-species?limit=2000");
  const data = await res.json();
  names = (data.results as { name: string }[]).map((p) =>
    p.name.split("-").map((w) => w[0].toUpperCase() + w.slice(1)).join("-")
  );
  return names;
}

function normalize(s: string) {
  return s.toLowerCase().replace(/[^a-z]/g, "");
}

function similarity(a: string, b: string) {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const bigrams = (s: string) => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      m.set(g, (m.get(g) ?? 0) + 1);
    }
    return m;
  };
  const A = bigrams(a), B = bigrams(b);
  let hits = 0;
  for (const [g, n] of A) hits += Math.min(n, B.get(g) ?? 0);
  return (2 * hits) / (a.length - 1 + b.length - 1);
}

function levenshtein(a: string, b: string) {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

// Maps noisy OCR/VLM output ("Chamaleon", "Pikachu ex 120") to a canonical Pokemon name, or null
export async function matchPokemon(raw: string): Promise<string | null> {
  const list = await loadNames();
  const cleaned = normalize(raw);
  if (!cleaned) return null;

  let best: string | null = null;
  let bestScore = 0;
  for (const name of list) {
    const n = normalize(name);
    let score: number;
    if (cleaned === n) score = 1;
    else if (cleaned.length < 6) score = 0; // short reads are too ambiguous for fuzzy matching
    else if (cleaned.includes(n) && n.length >= 4) score = 0.95;
    else score = Math.max(similarity(cleaned, n), 1 - levenshtein(cleaned, n) / Math.max(cleaned.length, n.length));
    if (score > bestScore) {
      bestScore = score;
      best = name;
    }
  }
  if (bestScore < 0.72 || !best) return null;
  const regional = REGIONAL_FORMS.find(([re]) => re.test(raw));
  return regional ? `${regional[1]} ${best}` : best;
}

// Regional forms are separate TCG cards ("Alolan Graveler"); cards in other languages print them
// as a suffix ("Graveler de Alola", "Graveler de Galar")
const REGIONAL_FORMS: [RegExp, string][] = [
  [/alola/i, "Alolan"],
  [/galar/i, "Galarian"],
  [/hisui/i, "Hisuian"],
  [/paldea/i, "Paldean"],
];
