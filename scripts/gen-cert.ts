// Generates a self-signed TLS certificate for localhost + this machine's LAN IPv4
// addresses so the scanner can be opened over https:// from a phone.
//
//   bun scripts/gen-cert.ts          # writes .certs/key.pem and .certs/cert.pem (skips if present)
//   bun scripts/gen-cert.ts --force  # regenerates (e.g. after the LAN IP changed)
//
// Uses `openssl` when it is on PATH, otherwise the pure-JS `selfsigned` package.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join } from "node:path";

const CERT_DIR = join(import.meta.dir, "..", ".certs");
const KEY_PATH = join(CERT_DIR, "key.pem");
const CERT_PATH = join(CERT_DIR, "cert.pem");
const DAYS = 825; // Apple caps leaf certificate validity at 825 days

// Non-internal IPv4 addresses, physical adapters first (WSL/Hyper-V/VM adapters are
// usually unreachable from a phone, so they sort last).
export function lanIPv4Addresses(): string[] {
  const virtual = /vethernet|wsl|hyper-v|virtualbox|vmware|docker|tailscale|zerotier/i;
  const out: { address: string; virtual: boolean }[] = [];
  for (const [name, entries] of Object.entries(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) {
        out.push({ address: entry.address, virtual: virtual.test(name) });
      }
    }
  }
  return out.sort((a, b) => Number(a.virtual) - Number(b.virtual)).map((e) => e.address);
}

async function withOpenssl(hosts: string[], ips: string[]): Promise<boolean> {
  const san = [...hosts.map((h) => `DNS:${h}`), ...ips.map((ip) => `IP:${ip}`)].join(",");
  try {
    const proc = Bun.spawn(
      [
        "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256",
        "-days", String(DAYS),
        "-keyout", KEY_PATH, "-out", CERT_PATH,
        "-subj", "/CN=localhost",
        "-addext", `subjectAltName=${san}`,
        "-addext", "basicConstraints=CA:FALSE",
        "-addext", "keyUsage=digitalSignature,keyEncipherment",
        "-addext", "extendedKeyUsage=serverAuth",
      ],
      { stdout: "ignore", stderr: "pipe" }
    );
    const code = await proc.exited;
    if (code !== 0) {
      console.warn("openssl failed:", await new Response(proc.stderr).text());
      return false;
    }
    return true;
  } catch {
    return false; // openssl not on PATH
  }
}

async function withSelfsigned(hosts: string[], ips: string[]) {
  const { generate } = await import("selfsigned");
  const now = new Date();
  const pems = await generate([{ name: "commonName", value: "localhost" }], {
    keySize: 2048,
    algorithm: "sha256",
    notBeforeDate: now,
    notAfterDate: new Date(now.getTime() + DAYS * 24 * 60 * 60 * 1000),
    extensions: [
      { name: "basicConstraints", cA: false },
      { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
      { name: "extKeyUsage", serverAuth: true },
      {
        name: "subjectAltName",
        altNames: [
          ...hosts.map((h) => ({ type: 2 as const, value: h })),
          ...ips.map((ip) => ({ type: 7 as const, ip })),
        ],
      },
    ],
  });
  writeFileSync(KEY_PATH, pems.private);
  writeFileSync(CERT_PATH, pems.cert);
}

async function main() {
  const force = process.argv.includes("--force");
  if (!force && existsSync(KEY_PATH) && existsSync(CERT_PATH)) {
    console.log(`Certificate already exists in ${CERT_DIR} (use --force to regenerate).`);
    return;
  }
  mkdirSync(CERT_DIR, { recursive: true });

  const hosts = ["localhost"];
  const ips = ["127.0.0.1", ...lanIPv4Addresses()];

  let tool = "openssl";
  if (!(await withOpenssl(hosts, ips))) {
    tool = "selfsigned";
    await withSelfsigned(hosts, ips);
  }

  console.log(`Wrote ${KEY_PATH} and ${CERT_PATH} (via ${tool})`);
  console.log(`Valid for: ${[...hosts, ...ips].join(", ")}`);
}

if (import.meta.main) await main();
