/**
 * server.js
 * Backend for the Card Benefit Activation Engine.
 * Built with ZERO external dependencies (Node's built-in http module only) —
 * just run `node server.js`, no npm install needed.
 *
 * Flow:
 *  1. Frontend POSTs a transaction to /api/transactions
 *  2. Server runs it through the rules engine (rules.js)
 *  3. Any matched benefits are stored as "entitlements" (in-memory DB here)
 *  4. Server responds immediately with the matched benefits + pre-filled claim data
 *  5. Frontend shows an alert / claim card right away
 *
 * Swap the `db` object for DynamoDB/MySQL later without touching the rules engine.
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");
const { evaluateTransaction } = require("./rules");

const PUBLIC_DIR = path.join(__dirname, "public");

// --- Fake in-memory "database" ---
const db = {
  transactions: [],
  entitlements: [],
  claims: [],
};

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
};

function sendJSON(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function serveStatic(req, res, urlPath) {
  let filePath = urlPath === "/" ? "/index.html" : urlPath;
  filePath = path.join(PUBLIC_DIR, filePath);

  // Prevent directory traversal outside public/
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      return res.end("Not found");
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(content);
  });
}

// --- Route handlers ---

// Shared core: takes a raw transaction object and runs it through the engine.
// Both the manual test endpoint AND the automated webhook call this same function —
// this is the one place "detection" actually happens.
function processTransaction(raw) {
  const tx = {
    id: randomUUID(),
    cardId: raw.cardId,
    merchantName: raw.merchantName,
    mccCode: String(raw.mccCode),
    amount: Number(raw.amount),
    date: raw.date,
    description: raw.description || "",
    createdAt: new Date().toISOString(),
  };
  db.transactions.push(tx);

  const matches = evaluateTransaction(tx);
  const newEntitlements = matches.map((m) => ({
    id: randomUUID(),
    transactionId: tx.id,
    ...m,
    status: "detected",
  }));
  db.entitlements.push(...newEntitlements);

  return { transaction: tx, entitlements: newEntitlements };
}

// POST /api/transactions
// DEV/TEST ONLY — this is the manual form endpoint, for typing in a fake
// transaction by hand to test the engine. Real production traffic never
// hits this route; see /api/webhooks/transactions below.
async function handlePostTransaction(req, res) {
  let body;
  try {
    body = await readBody(req);
  } catch {
    return sendJSON(res, 400, { error: "Invalid JSON body" });
  }

  const { cardId, merchantName, mccCode, amount, date } = body;
  if (!cardId || !merchantName || !mccCode || !amount || !date) {
    return sendJSON(res, 400, {
      error: "cardId, merchantName, mccCode, amount, and date are required",
    });
  }

  const { transaction, entitlements } = processTransaction(body);
  sendJSON(res, 201, {
    transaction,
    benefitsDetected: entitlements.length,
    entitlements,
  });
}

// POST /api/webhooks/transactions
// THIS is the real-world entry point. A card processor (Stripe Issuing,
// Marqeta, a bank's core processor, etc.) calls this automatically the
// instant a card is authorized at a merchant — no human types anything.
// The processor sends an event payload; we normalize it and run it through
// the exact same detection engine used above.
//
// In a real production deploy, /api/transactions (the manual test route)
// would be removed or locked behind dev-only auth, and this webhook route
// would be the ONLY way transactions enter the system.
async function handleWebhookTransaction(req, res) {
  let body;
  try {
    body = await readBody(req);
  } catch {
    return sendJSON(res, 400, { error: "Invalid JSON body" });
  }

  // Normalize a Stripe-Issuing-style authorization event into our internal shape.
  // Real Stripe Issuing sends: { type: "issuing_authorization.created", data: { object: {...} } }
  const event = body.data && body.data.object ? body.data.object : body;

  const normalized = {
    cardId: event.cardholder || event.card_id || event.cardId,
    merchantName: (event.merchant_data && event.merchant_data.name) || event.merchantName,
    mccCode: (event.merchant_data && event.merchant_data.category_code) || event.mccCode,
    amount: event.amount,
    date: event.created
      ? new Date(event.created * 1000).toISOString().slice(0, 10)
      : new Date().toISOString().slice(0, 10),
    description: (event.merchant_data && event.merchant_data.name) || event.description || "",
  };

  const { transaction, entitlements } = processTransaction(normalized);

  console.log(
    `[webhook] card authorization received: ${transaction.merchantName} $${transaction.amount} -> ${entitlements.length} benefit(s) matched`
  );

  // Real processors just need a fast 200 OK acknowledgement.
  sendJSON(res, 200, { received: true, benefitsDetected: entitlements.length });
}

function handleGetEntitlements(req, res, query) {
  let list = db.entitlements;
  if (query.cardId) {
    list = list.filter((e) => {
      const tx = db.transactions.find((t) => t.id === e.transactionId);
      return tx && tx.cardId === query.cardId;
    });
  }
  sendJSON(res, 200, list);
}

async function handlePostClaim(req, res) {
  let body;
  try {
    body = await readBody(req);
  } catch {
    return sendJSON(res, 400, { error: "Invalid JSON body" });
  }

  const { entitlementId, fields } = body;
  const entitlement = db.entitlements.find((e) => e.id === entitlementId);
  if (!entitlement) {
    return sendJSON(res, 404, { error: "Entitlement not found" });
  }

  const claim = {
    id: randomUUID(),
    entitlementId,
    fields: { ...entitlement.prefill, ...(fields || {}) },
    status: "submitted",
    submittedAt: new Date().toISOString(),
  };
  db.claims.push(claim);
  entitlement.status = "submitted";

  sendJSON(res, 201, claim);
}

function handleGetClaims(req, res) {
  sendJSON(res, 200, db.claims);
}

function handleGetTransactions(req, res) {
  sendJSON(res, 200, db.transactions);
}

// --- Router ---

const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
  const pathname = parsedUrl.pathname;
  const query = Object.fromEntries(parsedUrl.searchParams);

  try {
    if (req.method === "POST" && pathname === "/api/transactions") {
      return await handlePostTransaction(req, res);
    }
    if (req.method === "POST" && pathname === "/api/webhooks/transactions") {
      return await handleWebhookTransaction(req, res);
    }
    if (req.method === "GET" && pathname === "/api/entitlements") {
      return handleGetEntitlements(req, res, query);
    }
    if (req.method === "POST" && pathname === "/api/claims") {
      return await handlePostClaim(req, res);
    }
    if (req.method === "GET" && pathname === "/api/claims") {
      return handleGetClaims(req, res);
    }
    if (req.method === "GET" && pathname === "/api/transactions") {
      return handleGetTransactions(req, res);
    }
    if (req.method === "GET") {
      return serveStatic(req, res, pathname);
    }
    sendJSON(res, 404, { error: "Not found" });
  } catch (err) {
    console.error(err);
    sendJSON(res, 500, { error: "Internal server error" });
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Card Benefit Activation Engine running on http://localhost:${PORT}`);
});
