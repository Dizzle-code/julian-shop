const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const webpush = require("web-push");

const PORT = Number(process.env.PORT || 5731);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const ORDERS_FILE = path.join(DATA_DIR, "orders.json");
const METHODS_FILE = path.join(DATA_DIR, "payment-methods.json");
const SUBSCRIPTIONS_FILE = path.join(DATA_DIR, "push-subscriptions.json");
const VAPID_FILE = path.join(DATA_DIR, "vapid-keys.json");
const ADMIN_PIN = process.env.ADMIN_PIN || "1234";
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:julian-shop@example.com";
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
let subscriptions = loadJson(SUBSCRIPTIONS_FILE, []);

let vapidKeys = loadJson(VAPID_FILE, null);
if (!vapidKeys) {
  vapidKeys = webpush.generateVAPIDKeys();
  saveJson(VAPID_FILE, vapidKeys);
}
webpush.setVapidDetails(VAPID_SUBJECT, vapidKeys.publicKey, vapidKeys.privateKey);

const saveOrders = () => saveJson(ORDERS_FILE, orders);
const saveSubscriptions = () => saveJson(SUBSCRIPTIONS_FILE, subscriptions);

const STATUS_MESSAGES = {
  angenommen: "⏳ Julian hat deinen Auftrag angenommen und ist dran.",
  erledigt: "✅ Dein Auftrag ist fertig! Du kannst jetzt bezahlen.",
  bezahlt: "💚 Bezahlung bestätigt. Danke!",
  abgelehnt: "❌ Julian hat deinen Auftrag abgelehnt.",
};

function isValidSubscription(sub) {
  try {
    return new URL(sub.endpoint).protocol === "https:"
      && typeof sub.keys?.p256dh === "string"
      && typeof sub.keys?.auth === "string";
  } catch {
    return false;
  }
}

function addSubscription(sub, { admin = false, orderId = null }) {
  let entry = subscriptions.find((s) => s.endpoint === sub.endpoint);
  if (!entry) {
    entry = { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, admin: false, orderIds: [] };
    subscriptions.push(entry);
  }
  entry.keys = { p256dh: sub.keys.p256dh, auth: sub.keys.auth };
  if (admin) entry.admin = true;
  if (orderId && !entry.orderIds.includes(orderId)) entry.orderIds.push(orderId);
  saveSubscriptions();
}

async function pushTo(targets, payload) {
  const json = JSON.stringify(payload);
  const results = await Promise.allSettled(
    targets.map((s) => webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, json, { TTL: 86400 })),
  );
  const gone = new Set();
  results.forEach((result, i) => {
    if (result.status === "fulfilled") return;
    const code = result.reason?.statusCode;
    if (code === 404 || code === 410) gone.add(targets[i].endpoint);
    else console.error("Push fehlgeschlagen:", code ?? result.reason?.message);
  });
  if (gone.size) {
    subscriptions = subscriptions.filter((s) => !gone.has(s.endpoint));
    saveSubscriptions();
  }
}

function notifyFamily(order, body) {
  const targets = subscriptions.filter((s) => s.orderIds.includes(order.id));
  if (targets.length) pushTo(targets, { title: order.title, body, tag: order.id });
}

function notifyAdmin(title, body, order) {
  const targets = subscriptions.filter((s) => s.admin);
  if (targets.length) pushTo(targets, { title, body, tag: "admin-" + order.id });
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
    notifyAdmin("📨 Bezahlung gemeldet", `${order.requester}: ${order.title} (${order.paymentMethod})`, order);
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
    notifyFamily(order, order.proposal.status === "akzeptiert"
      ? `✅ Julian hat deinen Bezahl-Vorschlag "${order.proposal.text}" akzeptiert.`
      : `❌ Julian hat deinen Bezahl-Vorschlag "${order.proposal.text}" abgelehnt. Wähl bitte etwas anderes.`);
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
    notifyAdmin(
      order.proposal ? "💡 Neuer Bezahl-Vorschlag" : "🔄 Bezahlart gewählt",
      `${order.requester}: ${order.title} (${order.paymentMethod})`,
      order,
    );
    return send(res, 200, order);
  }

  if (req.method === "GET" && url.pathname === "/api/push/key") {
    return send(res, 200, { publicKey: vapidKeys.publicKey });
  }

  if (req.method === "POST" && url.pathname === "/api/push/subscribe") {
    const body = await readBody(req);
    if (!isValidSubscription(body.subscription ?? {})) return send(res, 400, { error: "Ungültige Subscription" });
    if (body.admin && !isAdmin(req)) return send(res, 401, { error: "Nur Julian darf das" });
    if (body.orderId && !findOrder(body.orderId)) return send(res, 404, { error: "Auftrag nicht gefunden" });
    addSubscription(body.subscription, { admin: Boolean(body.admin), orderId: body.orderId });
    return send(res, 200, { ok: true });
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
    notifyAdmin("🆕 Neuer Auftrag", `${requester}: ${title} (${order.proposal ? "Vorschlag: " : ""}${order.paymentMethod})`, order);
    return send(res, 201, order);
  }

  if (idMatch && (req.method === "PATCH" || req.method === "DELETE")) {
    if (!isAdmin(req)) return send(res, 401, { error: "Nur Julian darf das" });
    const index = orders.findIndex((o) => o.id === idMatch[1]);
    if (index === -1) return send(res, 404, { error: "Auftrag nicht gefunden" });

    if (req.method === "DELETE") {
      orders.splice(index, 1);
      saveOrders();
      const deletedId = idMatch[1];
      subscriptions.forEach((s) => { s.orderIds = s.orderIds.filter((id) => id !== deletedId); });
      subscriptions = subscriptions.filter((s) => s.admin || s.orderIds.length);
      saveSubscriptions();
      return send(res, 200, { ok: true });
    }

    const body = await readBody(req);
    const order = orders[index];
    const before = { status: order.status, method: order.paymentMethod, note: order.note };
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
    const messages = [];
    if (order.status !== before.status && STATUS_MESSAGES[order.status]) messages.push(STATUS_MESSAGES[order.status]);
    if (order.paymentMethod !== before.method) messages.push(`💳 Bezahlart: ${order.paymentMethod}`);
    if (order.note && order.note !== before.note) messages.push(`💬 Julian: ${order.note}`);
    if (messages.length) notifyFamily(order, messages.join("\n"));
    return send(res, 200, order);
  }

  return send(res, 404, { error: "Nicht gefunden" });
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
};

function serveStatic(res, url) {
  const file = path.normalize(path.join(PUBLIC_DIR, url.pathname === "/" ? "index.html" : url.pathname));
  if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, { error: "Verboten" });
  fs.readFile(file, (err, content) => {
    if (err) return send(res, 404, { error: "Nicht gefunden" });
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(file)] || "application/octet-stream",
      "Cache-Control": "no-cache",
    });
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
