const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const PORT = Number(process.env.PORT || 5731);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const ORDERS_FILE = path.join(DATA_DIR, "orders.json");
const METHODS_FILE = path.join(DATA_DIR, "payment-methods.json");
const ADMIN_PIN = process.env.ADMIN_PIN || "1234";
const PUBLIC_DIR = path.join(__dirname, "public");

const STATUSES = ["neu", "angenommen", "erledigt", "gemeldet", "bezahlt", "abgelehnt"];

fs.mkdirSync(DATA_DIR, { recursive: true });

function loadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function saveJson(file, value) {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

let orders = loadJson(ORDERS_FILE, []);
let paymentMethods = loadJson(METHODS_FILE, []);

const saveOrders = () => saveJson(ORDERS_FILE, orders);

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

function applyMethod(order, methodId) {
  const method = paymentMethods.find((m) => m.id === methodId);
  if (!method) return false;
  order.paymentMethodId = method.id;
  order.paymentMethod = method.name;
  order.proposal = null;
  return true;
}

function applyMethodOrProposal(order, body) {
  const proposal = cleanText(body.proposal, 120);
  if (proposal) {
    order.paymentMethodId = null;
    order.paymentMethod = proposal;
    order.proposal = { text: proposal, status: "offen" };
    return true;
  }
  return applyMethod(order, body.methodId);
}

function findOrder(id) {
  return orders.find((o) => o.id === id);
}

async function handleApi(req, res, url) {
  const idMatch = url.pathname.match(/^\/api\/orders\/([\w-]+)$/);
  const payMatch = url.pathname.match(/^\/api\/orders\/([\w-]+)\/pay$/);
  const proposalMatch = url.pathname.match(/^\/api\/orders\/([\w-]+)\/proposal$/);
  const methodMatch = url.pathname.match(/^\/api\/orders\/([\w-]+)\/method$/);

  if (req.method === "GET" && url.pathname === "/api/payment-methods") {
    return send(res, 200, paymentMethods);
  }

  if (req.method === "PUT" && url.pathname === "/api/payment-methods") {
    if (!isAdmin(req)) return send(res, 401, { error: "Nur Julian darf das" });
    const body = await readBody(req);
    if (!Array.isArray(body)) return send(res, 400, { error: "Liste erwartet" });
    const cleaned = body
      .map((m) => ({
        id: typeof m.id === "string" && /^[\w-]{1,64}$/.test(m.id) ? m.id : crypto.randomUUID(),
        name: cleanText(m.name, 50),
        instructions: cleanText(m.instructions, 500),
      }))
      .filter((m) => m.name)
      .slice(0, 20);
    paymentMethods = cleaned;
    saveJson(METHODS_FILE, paymentMethods);
    return send(res, 200, paymentMethods);
  }

  if (req.method === "POST" && payMatch) {
    const order = orders.find((o) => o.id === payMatch[1]);
    if (!order) return send(res, 404, { error: "Auftrag nicht gefunden" });
    if (order.status !== "erledigt") return send(res, 400, { error: "Nur erledigte Aufträge können bezahlt werden" });
    if (order.proposal && order.proposal.status !== "akzeptiert") {
      return send(res, 400, { error: "Der Bezahl-Vorschlag ist noch nicht akzeptiert" });
    }
    order.status = "gemeldet";
    order.updatedAt = new Date().toISOString();
    saveOrders();
    return send(res, 200, order);
  }

  if (req.method === "POST" && proposalMatch) {
    if (!isAdmin(req)) return send(res, 401, { error: "Nur Julian darf das" });
    const order = findOrder(proposalMatch[1]);
    if (!order) return send(res, 404, { error: "Auftrag nicht gefunden" });
    if (!order.proposal) return send(res, 400, { error: "Kein Vorschlag vorhanden" });
    const body = await readBody(req);
    if (body.action === "accept") {
      order.proposal.status = "akzeptiert";
      if (body.save) {
        const existing = paymentMethods.find((m) => m.name.toLowerCase() === order.proposal.text.toLowerCase());
        const method = existing ?? { id: crypto.randomUUID(), name: order.proposal.text.slice(0, 50), instructions: "" };
        if (!existing) {
          paymentMethods.push(method);
          saveJson(METHODS_FILE, paymentMethods);
        }
        order.paymentMethodId = method.id;
      }
    } else if (body.action === "reject") {
      order.proposal.status = "abgelehnt";
    } else {
      return send(res, 400, { error: "Unbekannte Aktion" });
    }
    order.updatedAt = new Date().toISOString();
    saveOrders();
    return send(res, 200, order);
  }

  if (req.method === "POST" && methodMatch) {
    const order = findOrder(methodMatch[1]);
    if (!order) return send(res, 404, { error: "Auftrag nicht gefunden" });
    if (order.proposal?.status !== "abgelehnt") return send(res, 400, { error: "Bezahlart kann hier nicht geändert werden" });
    const body = await readBody(req);
    if (!applyMethodOrProposal(order, body)) return send(res, 400, { error: "Bitte eine Bezahlart auswählen oder etwas vorschlagen" });
    order.updatedAt = new Date().toISOString();
    saveOrders();
    return send(res, 200, order);
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
      dueDate: cleanText(body.dueDate, 10) || null,
      status: "neu",
      note: "",
      paymentMethodId: null,
      paymentMethod: null,
      proposal: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    if (!applyMethodOrProposal(order, body)) return send(res, 400, { error: "Bitte eine Bezahlart auswählen oder etwas vorschlagen" });
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
    if (body.methodId && body.methodId !== order.paymentMethodId && !applyMethod(order, body.methodId)) {
      return send(res, 400, { error: "Bezahlart unbekannt" });
    }
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
