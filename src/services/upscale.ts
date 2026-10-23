import sharp from "sharp";

const MIN_WIDTH = 800;
const BLANK_STDDEV = 10;

// Solid-color / covered-lens frames make the vision model hallucinate a card, so skip them
export async function isBlank(base64: string): Promise<boolean> {
  const { channels } = await sharp(Buffer.from(base64, "base64")).stats();
  const avgStdev = channels.reduce((s, c) => s + c.stdev, 0) / channels.length;
  return avgStdev < BLANK_STDDEV;
}

// Qwen2.5-VL reads small/moderate images best and degrades on large upscales,
// so this only enlarges tiny snapshots and re-encodes losslessly to drop JPEG artifacts
export async function upscale(base64: string): Promise<string> {
  const input = Buffer.from(base64, "base64");
  const meta = await sharp(input).metadata();
  let pipeline = sharp(input);
  if ((meta.width ?? 0) < MIN_WIDTH) {
    pipeline = pipeline.resize({ width: MIN_WIDTH, kernel: sharp.kernel.lanczos3 });
  }
  const out = await pipeline.png().toBuffer();
  return out.toString("base64");
}
