const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const PORT = Number(process.env.PORT || 5731);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "orders.json");
const ADMIN_PIN = process.env.ADMIN_PIN || "1234";
const PAYPAL_ME = process.env.PAYPAL_ME || "";
const PUBLIC_DIR = path.join(__dirname, "public");

const STATUSES = ["neu", "angenommen", "erledigt", "bezahlt", "abgelehnt"];

fs.mkdirSync(DATA_DIR, { recursive: true });

function loadOrders() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch {
    return [];
  }
}

let orders = loadOrders();

function saveOrders() {
  const tmp = DATA_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(orders, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

function isAdmin(req) {
  const given = crypto.createHash("sha256").update(String(req.headers["x-admin-pin"] || "")).digest();
  const expected = crypto.createHash("sha256").update(ADMIN_PIN).digest();
  return crypto.timingSafeEqual(given, expected);
}

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 100_000) reject(new Error("Body zu groß"));
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error("Ungültiges JSON"));
      }
    });
    req.on("error", reject);
  });
}

function cleanText(value, max) {
  return String(value ?? "").trim().slice(0, max);
}

function cleanAmount(value) {
  const amount = Math.round(Number(value) * 100) / 100;
  return Number.isFinite(amount) && amount >= 0 ? amount : null;
}

async function handleApi(req, res, url) {
  const idMatch = url.pathname.match(/^\/api\/orders\/([\w-]+)$/);

  if (req.method === "GET" && url.pathname === "/api/config") {
    return send(res, 200, { paypalMe: PAYPAL_ME });
  }

  if (req.method === "POST" && url.pathname === "/api/login") {
    return isAdmin(req) ? send(res, 200, { ok: true }) : send(res, 401, { error: "Falsche PIN" });
  }

  if (req.method === "GET" && url.pathname === "/api/orders") {
    const sorted = [...orders].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return send(res, 200, sorted);
  }

  if (req.method === "POST" && url.pathname === "/api/orders") {
    const body = await readBody(req);
    const requester = cleanText(body.requester, 50);
    const title = cleanText(body.title, 120);
    if (!requester || !title) return send(res, 400, { error: "Name und Titel sind Pflicht" });
    const order = {
      id: crypto.randomUUID(),
      requester,
      title,
      description: cleanText(body.description, 2000),
      offer: cleanAmount(body.offer) ?? 0,
      price: null,
      dueDate: cleanText(body.dueDate, 10) || null,
      status: "neu",
      note: "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    orders.push(order);
    saveOrders();
    return send(res, 201, order);
  }

  if (idMatch && (req.method === "PATCH" || req.method === "DELETE")) {
    if (!isAdmin(req)) return send(res, 401, { error: "Nur Julian darf das" });
    const index = orders.findIndex((o) => o.id === idMatch[1]);
    if (index === -1) return send(res, 404, { error: "Auftrag nicht gefunden" });

    if (req.method === "DELETE") {
      orders.splice(index, 1);
      saveOrders();
      return send(res, 200, { ok: true });
    }

    const body = await readBody(req);
    const order = orders[index];
    if (body.status !== undefined) {
      if (!STATUSES.includes(body.status)) return send(res, 400, { error: "Ungültiger Status" });
      order.status = body.status;
    }
    if (body.price !== undefined) order.price = body.price === null ? null : cleanAmount(body.price);
    if (body.note !== undefined) order.note = cleanText(body.note, 500);
    order.updatedAt = new Date().toISOString();
    saveOrders();
    return send(res, 200, order);
  }

  return send(res, 404, { error: "Nicht gefunden" });
}

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };

function serveStatic(res, url) {
  const file = path.normalize(path.join(PUBLIC_DIR, url.pathname === "/" ? "index.html" : url.pathname));
  if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, { error: "Verboten" });
  fs.readFile(file, (err, content) => {
    if (err) return send(res, 404, { error: "Nicht gefunden" });
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(content);
  });
}

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    try {
      if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);
      serveStatic(res, url);
    } catch (err) {
      send(res, 400, { error: err.message });
    }
  })
  .listen(PORT, () => console.log(`Julian-Shop läuft auf Port ${PORT}`));
