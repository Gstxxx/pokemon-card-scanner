export type Finish = "holofoil" | "reverse" | "normal";

export interface CardIdentification {
  name: string;
  set: string;
  number: string;
  /** Printed set size, the part after the slash in "013/094" -> "94". Empty when not printed. */
  printedTotal: string;
  finish: Finish | null;
  confidence: number;
}

const MODEL = process.env.VISION_MODEL ?? "qwen2.5vl:7b";
const OLLAMA_URL = (process.env.OLLAMA_URL ?? "http://localhost:11434").replace(/\/$/, "");
const MAX_RETRIES = 1;
const NO_CARD = Symbol("no_card");

const PROMPT = `Look at the Pokemon trading card in this photo and transcribe exactly, letter by letter, without guessing from the artwork:
1. the name printed in the title bar at the top of the card;
2. the collector number printed in small text at the bottom of the card, which looks like "013/094" or "SV7" (NOT the HP number at the top). Copy it whole, including the part after the slash;
3. judge the card SURFACE, not the drawing: "artwork_shiny" = the picture box shows a rainbow / glittery / holographic foil reflection (streaks, sparkle, metallic sheen); "border_shiny" = the border, text boxes or background outside the picture show that foil effect while the picture itself is matte.
Reply with only this JSON: {"printed_name": "<name, or empty string if there is no readable card name>", "number": "<collector number as printed, or empty string>", "set": "<set name if printed, else empty>", "artwork_shiny": true|false, "border_shiny": true|false, "finish": "<holofoil if only the artwork is shiny, reverse if the border/background is shiny, normal if neither>"}`;

// The model sometimes drops the slash ("10/102" -> "10102"); put it back when the split makes sense
function recoverSlash(raw: string): string {
  const s = raw.trim();
  if (!/^\d{5,6}$/.test(s)) return s;
  for (const totalLen of [3, 2]) {
    const num = parseInt(s.slice(0, -totalLen), 10), total = parseInt(s.slice(-totalLen), 10);
    if (num >= 1 && total >= 10 && num <= total) return `${s.slice(0, -totalLen)}/${s.slice(-totalLen)}`;
  }
  return s;
}

// "013/094" -> "13", "SV7" -> "SV7", "-110" (misread HP) -> ""
function normalizeNumber(raw: string): string {
  const first = recoverSlash(raw).split("/")[0].trim();
  if (!/^[A-Za-z]{0,4}\d{1,3}[a-z]?$/.test(first)) return "";
  return first.replace(/^([A-Za-z]*)0+(\d)/, "$1$2");
}

// "013/094" -> "94", "SV7" -> "", "13/TG30" -> "30"
function parsePrintedTotal(raw: string): string {
  const after = recoverSlash(raw).split("/")[1]?.trim() ?? "";
  const digits = after.match(/\d{1,3}/)?.[0];
  if (!digits) return "";
  return String(parseInt(digits, 10));
}

// The two surface flags are more reliable than the model's own label, so they win when present
function normalizeFinish(raw: unknown, artworkShiny?: unknown, borderShiny?: unknown): Finish | null {
  const flag = (v: unknown) => (typeof v === "boolean" ? v : /^true$/i.test(String(v ?? "")) ? true : /^false$/i.test(String(v ?? "")) ? false : null);
  const art = flag(artworkShiny), border = flag(borderShiny);
  if (border === true) return "reverse";
  if (art === true) return "holofoil";
  if (art === false && border === false) return "normal";
  const s = String(raw ?? "").toLowerCase();
  if (/reverse/.test(s)) return "reverse";
  if (/holo|foil|shiny/.test(s)) return "holofoil";
  if (/normal|non|matte|regular|none/.test(s)) return "normal";
  return null;
}

export async function identifyCard(
  base64Image: string
): Promise<CardIdentification | null> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const result = await tryIdentify(base64Image);
    if (result === NO_CARD) return null;
    if (result) return result;
  }
  return null;
}

async function tryIdentify(base64Image: string): Promise<CardIdentification | typeof NO_CARD | null> {
  try {
    const response = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "user", content: PROMPT, images: [base64Image] }],
        stream: false,
        options: { temperature: 0 },
      }),
    });

    if (!response.ok) return null;

    const data = await response.json();
    const text: string = data.message?.content ?? "";
    console.log("[Vision] Raw:", text.replace(/\s+/g, " ").slice(0, 200));

    const jsonMatch = text.match(/\{[^}]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]);
    const name = String(parsed.printed_name ?? parsed.name ?? "").trim();
    if (!name || /transcription|unknown|n\/a|none/i.test(name)) return NO_CARD;

    const rawNumber = String(parsed.number ?? "");
    return {
      name,
      set: String(parsed.set ?? ""),
      number: normalizeNumber(rawNumber),
      printedTotal: parsePrintedTotal(rawNumber),
      finish: normalizeFinish(parsed.finish, parsed.artwork_shiny, parsed.border_shiny),
      confidence: 0.9,
    };
  } catch {
    return null;
  }
}
