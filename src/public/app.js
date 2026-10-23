const video = document.getElementById("camera");
const canvas = document.getElementById("capture-canvas");
const ctx = canvas.getContext("2d");
const scanBtn = document.getElementById("scan-btn");
const slotsEl = document.getElementById("slots");
const totalEl = document.getElementById("total-value");
const countEl = document.getElementById("count");
const overlay = document.getElementById("camera-overlay");
const snap = document.getElementById("snap");
const snapImg = document.getElementById("snap-img");
const snapText = document.getElementById("snap-text");
const connDot = document.getElementById("conn-dot");
const connText = document.getElementById("conn-text");
const statusEl = document.getElementById("scan-status");
const toastEl = document.getElementById("toast");

const MIN_SLOTS = 9;
const SLOT_STEP = 9;
const CAPTURE_MS = 2500;
const RESULT_MS = 1600;

let ws = null;
let stream = null;
let scanning = false;
let confirming = false;
let timer = null;
let reconnectDelay = 1000;
let cards = []; // rows from /api/cards, in reading order (id ascending)
let sortMode = "added"; // "added" | "value"
const sortBtns = document.querySelectorAll("[data-sort]");

async function loadCards() {
  try {
    const res = await fetch("/api/cards");
    if (!res.ok) throw new Error(res.status);
    cards = await res.json();
  } catch {
    toast("Não consegui carregar o álbum");
  }
  render();
}

function connect() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${proto}//${location.host}/ws`);

  ws.onopen = () => {
    reconnectDelay = 1000;
    connDot.classList.add("on");
    connText.textContent = "Conectado";
  };

  ws.onclose = () => {
    connDot.classList.remove("on");
    connText.textContent = "Desconectado";
    scanBtn.disabled = true;
    stopScanning();
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 16000);
  };

  ws.onerror = () => ws.close();

  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === "hello") {
      const prev = sessionStorage.getItem("boot");
      sessionStorage.setItem("boot", String(msg.boot));
      if (prev && prev !== String(msg.boot)) location.reload();
      else autoStart();
      return;
    }
    if (confirming) return onConfirmResult(msg);
    if (msg.type === "maybe") startConfirm(msg.name);
    else if (msg.type === "no_card" && scanning) statusEl.textContent = "Procurando carta...";
  };
}

async function startCamera() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment", width: { ideal: 1920 }, height: { ideal: 1080 } },
    });
    video.srcObject = stream;
    overlay.classList.add("hidden");
    autoStart();
  } catch {
    overlay.querySelector("span").textContent = "Sem acesso à câmera";
  }
}

function autoStart() {
  if (!stream || !ws || ws.readyState !== WebSocket.OPEN) return;
  scanBtn.disabled = false;
  if (!scanning) startScanning();
}

// draws only the region visible in the viewfinder (object-fit: cover crop)
function grabFrame(quality) {
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh) return null;
  const target = video.clientWidth / video.clientHeight;
  let sw = vw, sh = vh;
  if (vw / vh > target) sw = Math.round(vh * target);
  else sh = Math.round(vw / target);
  const sx = Math.round((vw - sw) / 2), sy = Math.round((vh - sh) / 2);
  canvas.width = sw;
  canvas.height = sh;
  ctx.drawImage(video, sx, sy, sw, sh, 0, 0, sw, sh);
  return canvas.toDataURL("image/jpeg", quality);
}

function sendLiveFrame() {
  if (confirming || !stream || !ws || ws.readyState !== WebSocket.OPEN) return;
  const url = grabFrame(0.8);
  if (!url) return;
  ws.send(JSON.stringify({ type: "frame", data: url.split(",")[1] }));
}

function startConfirm(name) {
  if (confirming) return;
  const url = grabFrame(0.95);
  if (!url) return;
  confirming = true;
  clearInterval(timer);
  timer = null;

  snapImg.src = url;
  snapText.textContent = `Parece ${name}... analisando foto`;
  snap.classList.remove("done");
  snap.classList.add("show");
  statusEl.textContent = "Foto tirada, lendo em alta resolução";

  ws.send(JSON.stringify({ type: "confirm", data: url.split(",")[1] }));
}

async function onConfirmResult(msg) {
  snap.classList.add("done");
  if (msg.type === "card") {
    const added = await addCard(msg);
    snapText.textContent =
      added == null ? `Falha ao salvar ${msg.name}` : added ? `${msg.name} colada no álbum` : `${msg.name} já está no álbum`;
  } else {
    snapText.textContent = "Não consegui confirmar";
  }
  setTimeout(resumeLive, RESULT_MS);
}

function resumeLive() {
  snap.classList.remove("show", "done");
  snapImg.removeAttribute("src");
  confirming = false;
  if (scanning) {
    statusEl.textContent = "Procurando carta...";
    timer = setInterval(sendLiveFrame, CAPTURE_MS);
  }
}

function startScanning() {
  scanning = true;
  scanBtn.textContent = "Pausar";
  scanBtn.classList.add("active");
  statusEl.textContent = "Procurando carta...";
  sendLiveFrame();
  timer = setInterval(sendLiveFrame, CAPTURE_MS);
}

function stopScanning() {
  scanning = false;
  clearInterval(timer);
  timer = null;
  scanBtn.textContent = "Escanear";
  scanBtn.classList.remove("active");
  if (!confirming) statusEl.textContent = "Pausado.";
}

scanBtn.addEventListener("click", () => (scanning ? stopScanning() : startScanning()));

function key(c) {
  return `${c.name}||${c.number}`;
}

// persists through the server; resolves true (new), false (duplicate) or null (request failed)
async function addCard(card) {
  if (cards.some((c) => key(c) === key(card))) return false;
  try {
    const res = await fetch("/api/cards", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(card),
    });
    if (!res.ok) throw new Error(res.status);
    const row = await res.json();
    if (!cards.some((c) => c.id === row.id)) cards.push(row);
    render();
    return row.created !== false;
  } catch {
    toast("Erro ao salvar no álbum");
    return null;
  }
}

async function removeCard(id) {
  const idx = cards.findIndex((c) => c.id === id);
  if (idx < 0) return;
  const [card] = cards.splice(idx, 1);
  render();
  try {
    const res = await fetch(`/api/cards/${id}`, { method: "DELETE" });
    if (!res.ok && res.status !== 404) throw new Error(res.status);
    toast(`${card.name} removida`);
  } catch {
    cards.splice(idx, 0, card);
    render();
    toast("Erro ao remover");
  }
}

slotsEl.addEventListener("click", (e) => {
  const btn = e.target.closest(".remove");
  if (btn) removeCard(Number(btn.dataset.id));
});

function setSort(mode) {
  sortMode = mode;
  sortBtns.forEach((b) => b.classList.toggle("active", b.dataset.sort === mode));
  render();
}
sortBtns.forEach((b) => b.addEventListener("click", () => setSort(b.dataset.sort)));

function sorted() {
  if (sortMode !== "value") return cards;
  return [...cards].sort((a, b) => (price(b) ?? -1) - (price(a) ?? -1) || a.id - b.id);
}

function price(c) {
  return c.prices?.market ?? c.prices?.mid ?? null;
}

function fmt(v, currency) {
  return (currency === "EUR" ? "€" : "$") + v.toFixed(2);
}

function fmtBrl(v) {
  return v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

// USD/EUR -> BRL rates from the server, used for album rows that were saved without a BRL value
let fx = null;
async function loadFx() {
  try {
    const res = await fetch("/api/fx");
    fx = res.ok ? await res.json() : null;
  } catch {
    fx = null;
  }
  render();
}

function brlOf(c) {
  if (c.brl != null) return c.brl;
  const p = price(c);
  if (p == null || !fx) return null;
  return Math.round(p * (c.currency === "EUR" ? fx.eurBrl : fx.usdBrl) * 100) / 100;
}

const VARIANT_TAG = {
  holofoil: "HOLO",
  reverseHolofoil: "REV",
  "1stEditionHolofoil": "1ª ED HOLO",
  unlimitedHolofoil: "HOLO",
  "1stEdition": "1ª ED",
  unlimited: "NORMAL",
  normal: "NORMAL",
  cardmarket: "CM",
  reverse: "REV",
};
function variantTag(c) {
  const v = c.variant ?? c.finish;
  return v ? VARIANT_TAG[v] ?? String(v).toUpperCase() : "";
}

function priceBlock(c) {
  const p = price(c);
  if (p == null) return `<span class="price none">s/ preço</span>`;
  const brl = brlOf(c);
  const tag = variantTag(c);
  return `
    <span class="price-block">
      <span class="price-row">
        ${tag ? `<span class="variant">${tag}</span>` : ""}
        <span class="price">${brl != null ? fmtBrl(brl) : fmt(p, c.currency)}</span>
      </span>
      ${brl != null ? `<span class="price-orig">${fmt(p, c.currency)}</span>` : ""}
    </span>`;
}

function render() {
  const total = Math.max(MIN_SLOTS, Math.ceil((cards.length + 1) / SLOT_STEP) * SLOT_STEP);
  const view = sorted();
  slotsEl.innerHTML = "";

  for (let i = 0; i < total; i++) {
    const c = view[i];
    const slot = document.createElement("div");
    slot.className = "pocket" + (c ? " filled" : "");

    const p = c ? price(c) : null;
    slot.innerHTML = `
      <div class="pocket-frame">
        <span class="pocket-num">${String(i + 1).padStart(2, "0")}</span>
        <span class="mark"></span>
        ${c ? `<button type="button" class="remove" data-id="${c.id}" title="Remover ${c.name}" aria-label="Remover ${c.name}">×</button>` : ""}
        ${c ? (c.image ? `<img src="${c.image}" alt="${c.name}" loading="lazy">` : `<span class="blank">${c.name}</span>`) : ""}
      </div>
      <div class="caption">
        ${c ? `
          <div class="card-name">${c.name}</div>
          <div class="card-line">
            <span class="card-set">${c.set || ""}${c.number ? " · " + c.number : ""}</span>
            ${priceBlock(c)}
          </div>` : ""}
      </div>`;
    slotsEl.appendChild(slot);
  }

  // header total in R$ once every priced card can be converted, otherwise in the original currency
  const priced = cards.filter((c) => price(c) != null);
  if (priced.length > 0 && priced.every((c) => brlOf(c) != null)) {
    totalEl.textContent = fmtBrl(priced.reduce((s, c) => s + brlOf(c), 0));
  } else {
    const sum = cards.reduce((s, c) => s + (price(c) ?? 0), 0);
    totalEl.textContent = fmt(sum, cards.find((c) => c.currency === "EUR" && price(c) != null) ? "EUR" : "USD");
  }
  countEl.textContent = cards.length;
}

let toastTimer = null;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("show"), 1800);
}

// ---------- phone QR overlay ----------
const phoneBtn = document.getElementById("phone-btn");
const phoneOverlay = document.getElementById("phone-overlay");
const phoneQr = document.getElementById("phone-qr");
const phoneUrl = document.getElementById("phone-url");

async function openPhone() {
  phoneOverlay.hidden = false;
  phoneBtn.setAttribute("aria-expanded", "true");
  try {
    const res = await fetch("/api/phone");
    if (!res.ok) throw new Error(res.status);
    const { url } = await res.json();
    phoneUrl.textContent = url;
    phoneUrl.href = url;
    phoneQr.innerHTML = `<img src="/qr.svg?t=${Date.now()}" alt="QR code para ${url}">`;
  } catch {
    phoneQr.innerHTML = `<span class="phone-wait">HTTPS desligado.<br>Rode <code>bun scripts/gen-cert.ts</code> e reinicie o servidor.</span>`;
    phoneUrl.textContent = "";
    phoneUrl.removeAttribute("href");
  }
}

function closePhone() {
  phoneOverlay.hidden = true;
  phoneBtn.setAttribute("aria-expanded", "false");
}

phoneBtn.addEventListener("click", () => (phoneOverlay.hidden ? openPhone() : closePhone()));
document.getElementById("phone-close").addEventListener("click", closePhone);
phoneOverlay.addEventListener("click", (e) => { if (e.target === phoneOverlay) closePhone(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !phoneOverlay.hidden) closePhone(); });
// the phone is already the scanner, so hide the button there
if (location.protocol === "https:" && !["localhost", "127.0.0.1"].includes(location.hostname)) phoneBtn.hidden = true;
else if (location.hash === "#celular") openPhone();

render();
loadFx();
loadCards();
startCamera();
connect();
