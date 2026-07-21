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
require("dotenv").config();
const http = require("http");
const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");
const { evaluateTransaction } = require("./rules");
const db = require("./db");

const PUBLIC_DIR = path.join(__dirname, "public");

// // --- Fake in-memory "database" ---
// const db = {
//   transactions: [],
//   entitlements: [],
//   claims: [],
// };

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
async function processTransaction(raw) {
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
  await db.query(
    `INSERT INTO transactions (id, card_id, merchant_name, mcc_code, amount, purchase_date, description)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [tx.id, tx.cardId, tx.merchantName, tx.mccCode, tx.amount, tx.date, tx.description]
  );

  // 2. Run Engine Rules
  const matches = evaluateTransaction(tx);

  // 3. Save Entitlements to Supabase
  const newEntitlements = [];
  for (const m of matches) {
    const ent = {
      id: randomUUID(),
      transactionId: tx.id,
      ...m,
      status: "detected",
    };

    await db.query(
      `INSERT INTO entitlements (id, transaction_id, benefit_type, label, reason, detected_at, expires_at, max_coverage, prefill, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        ent.id,
        ent.transactionId,
        ent.benefitType,
        ent.label,
        ent.reason,
        ent.detectedAt,
        ent.expiresAt,
        ent.maxCoverage,
        JSON.stringify(ent.prefill),
        ent.status,
      ]
    );

    newEntitlements.push(ent);
  }

  return { transaction: tx, entitlements: newEntitlements };
}

// POST /api/transactions
// DEV/TEST ONLY — this is the manual form endpoint, for typing in a fake
// transaction by hand to test the engine. Real production traffic never
// hits this route; see /api/webhooks/transactions below.
async function handlePostTransaction(req, res) {
  try {
    const body = await readBody(req);
    const { cardId, merchantName, mccCode, amount, date } = body;
    if (!cardId || !merchantName || !mccCode || !amount || !date) {
      return sendJSON(res, 400, { error: "Missing required fields" });
    }

    const { transaction, entitlements } = await processTransaction(body);
    sendJSON(res, 201, {
      transaction,
      benefitsDetected: entitlements.length,
      entitlements,
    });
  } catch (err) {
    console.error("Error processing transaction:", err);
    sendJSON(res, 500, { error: "Server error" });
  }
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

  const { transaction, entitlements } = await processTransaction(normalized);

  console.log(
    `[webhook] card authorization received: ${transaction.merchantName} $${transaction.amount} -> ${entitlements.length} benefit(s) matched`
  );

  // Real processors just need a fast 200 OK acknowledgement.
  sendJSON(res, 200, { received: true, benefitsDetected: entitlements.length });
}

async function handleGetEntitlements(req, res, query) {
  try {
    let sql = `
      SELECT e.*, t.card_id 
      FROM entitlements e
      JOIN transactions t ON e.transaction_id = t.id
    `;
    const params = [];

    if (query.cardId) {
      sql += ` WHERE t.card_id = $1`;
      params.push(query.cardId);
    }

    sql += ` ORDER BY e.detected_at DESC`;

    const result = await db.query(sql, params);
    const entitlements = result.rows.map((row) => ({
      id: row.id,
      transactionId: row.transaction_id,
      benefitType: row.benefit_type,
      label: row.label,
      reason: row.reason,
      detectedAt: row.detected_at,
      expiresAt: row.expires_at,
      maxCoverage: row.max_coverage,
      prefill: typeof row.prefill === "string" ? JSON.parse(row.prefill) : row.prefill,
      status: row.status,
    }));

    sendJSON(res, 200, entitlements);
  } catch (err) {
    console.error("Get entitlements error:", err);
    sendJSON(res, 500, { error: "Failed to fetch entitlements" });
  }
}


async function handlePostClaim(req, res) {
  try {
    const body = await readBody(req);
    const { entitlementId, fields } = body;

    const entRes = await db.query(`SELECT * FROM entitlements WHERE id = $1`, [entitlementId]);
    if (entRes.rows.length === 0) {
      return sendJSON(res, 404, { error: "Entitlement not found" });
    }

    const entitlement = entRes.rows[0];
    const prefillData = typeof entitlement.prefill === "string" ? JSON.parse(entitlement.prefill) : entitlement.prefill;
    const claimId = randomUUID();
    const mergedFields = { ...prefillData, ...(fields || {}) };

    await db.query(
      `INSERT INTO claims (id, entitlement_id, fields, status) VALUES ($1, $2, $3, $4)`,
      [claimId, entitlementId, JSON.stringify(mergedFields), "submitted"]
    );

    await db.query(`UPDATE entitlements SET status = 'submitted' WHERE id = $1`, [entitlementId]);

    sendJSON(res, 201, { id: claimId, entitlementId, status: "submitted" });
  } catch (err) {
    console.error("Post claim error:", err);
    sendJSON(res, 500, { error: "Claim submission failed" });
  }
}

async function handleGetClaims(req, res) {
  try {
    const result = await db.query(`SELECT * FROM claims ORDER BY submitted_at DESC`);
    const claims = result.rows.map(row => ({
      id: row.id,
      entitlementId: row.entitlement_id,
      fields: typeof row.fields === "string" ? JSON.parse(row.fields) : row.fields,
      status: row.status,
      submittedAt: row.submitted_at
    }));
    sendJSON(res, 200, claims);
  } catch (err) {
    console.error("Get claims error:", err);
    sendJSON(res, 500, { error: "Failed to fetch claims" });
  }
}

async function handleGetTransactions(req, res) {
  try {
    const result = await db.query(`SELECT * FROM transactions ORDER BY created_at DESC`);
    sendJSON(res, 200, result.rows);
  } catch (err) {
    console.error("Get transactions error:", err);
    sendJSON(res, 500, { error: "Failed to fetch transactions" });
  }
}

// GET /api/benefits-history
// Returns all entitlements joined with transaction details and claim status
// for the Claimed Benefits History panel on the frontend.
async function handleGetBenefitsHistory(req, res) {
  try {
    const result = await db.query(`
      SELECT 
        e.id,
        e.benefit_type,
        e.label,
        e.reason,
        e.detected_at,
        e.expires_at,
        e.max_coverage,
        e.prefill,
        e.status,
        t.card_id,
        t.merchant_name,
        t.mcc_code,
        t.amount,
        t.purchase_date,
        t.description AS tx_description,
        c.id AS claim_id,
        c.submitted_at AS claim_submitted_at
      FROM entitlements e
      JOIN transactions t ON e.transaction_id = t.id
      LEFT JOIN claims c ON c.entitlement_id = e.id
      ORDER BY e.detected_at DESC
    `);

    const history = result.rows.map(row => ({
      id: row.id,
      benefitType: row.benefit_type,
      label: row.label,
      reason: row.reason,
      detectedAt: row.detected_at,
      expiresAt: row.expires_at,
      maxCoverage: parseFloat(row.max_coverage),
      prefill: typeof row.prefill === "string" ? JSON.parse(row.prefill) : row.prefill,
      status: row.status,
      cardId: row.card_id,
      merchantName: row.merchant_name,
      mccCode: row.mcc_code,
      amount: parseFloat(row.amount),
      purchaseDate: row.purchase_date,
      txDescription: row.tx_description,
      claimId: row.claim_id,
      claimSubmittedAt: row.claim_submitted_at,
    }));

    sendJSON(res, 200, history);
  } catch (err) {
    console.error("Get benefits history error:", err);
    sendJSON(res, 500, { error: "Failed to fetch benefits history" });
  }
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
      return await handleGetEntitlements(req, res, query);
    }
    if (req.method === "POST" && pathname === "/api/claims") {
      return await handlePostClaim(req, res);
    }
    if (req.method === "GET" && pathname === "/api/claims") {
      return await handleGetClaims(req, res);
    }
    if (req.method === "GET" && pathname === "/api/transactions") {
      return await handleGetTransactions(req, res);
    }
    if (req.method === "GET" && pathname === "/api/benefits-history") {
      return await handleGetBenefitsHistory(req, res);
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
