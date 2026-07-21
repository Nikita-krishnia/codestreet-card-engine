/**
 * simulator.js
 * Stands in for the card network / issuer processor (Stripe Issuing, Marqeta, etc).
 *
 * In real life, THIS is what actually creates transactions — not a person
 * typing into a form. This script randomly "swipes" a card every few seconds
 * and POSTs a Stripe-Issuing-shaped webhook event to your server, exactly
 * like a real processor would when a cardholder pays at a merchant.
 *
 * Run this ALONGSIDE server.js (in a second terminal):
 *   node simulator.js
 *
 * Then just watch the dashboard at http://localhost:3000 — benefit alerts
 * will appear on their own, with nobody touching the form.
 */

const http = require("http");

const SERVER_URL = "http://localhost:3000/api/webhooks/transactions";
const CARD_IDS = ["card_001", "card_002", "card_003"];

// A pool of realistic merchants across different MCCs, so you see a mix of
// matches and non-matches — just like real spending patterns.
const MERCHANT_POOL = [
  { name: "Best Buy", mcc: "5732", amountRange: [80, 1500] },        // electronics -> purchase+return protection
  { name: "IKEA", mcc: "5712", amountRange: [50, 900] },              // furniture -> purchase+return protection
  { name: "United Airlines", mcc: "3000", amountRange: [150, 900] },  // travel -> travel delay
  { name: "Delta Air Lines", mcc: "3001", amountRange: [150, 900] },  // travel -> travel delay
  { name: "Zara", mcc: "5651", amountRange: [30, 300] },              // clothing -> purchase+return protection
  { name: "Local Coffee Shop", mcc: "5814", amountRange: [3, 15] },   // no benefit
  { name: "Shell Gas Station", mcc: "5541", amountRange: [20, 90] },  // no benefit
  { name: "Whole Foods", mcc: "5411", amountRange: [15, 200] },       // no benefit
];

function randomFrom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomAmount([min, max]) {
  return Math.round((Math.random() * (max - min) + min) * 100) / 100;
}

// Build a payload shaped like a real Stripe Issuing authorization event.
// https://stripe.com/docs/api/issuing/authorizations/object
function buildStripeStyleEvent() {
  const merchant = randomFrom(MERCHANT_POOL);
  return {
    type: "issuing_authorization.created",
    data: {
      object: {
        id: "iauth_" + Math.random().toString(36).slice(2, 10),
        cardholder: randomFrom(CARD_IDS),
        amount: randomAmount(merchant.amountRange),
        created: Math.floor(Date.now() / 1000),
        merchant_data: {
          name: merchant.name,
          category_code: merchant.mcc,
        },
      },
    },
  };
}

function fireTransaction() {
  const event = buildStripeStyleEvent();
  const body = JSON.stringify(event);

  const req = http.request(
    SERVER_URL,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    },
    (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        const merchant = event.data.object.merchant_data.name;
        const amount = event.data.object.amount;
        console.log(
          `[card network] ${merchant} charged $${amount} on ${event.data.object.cardholder} -> server responded: ${data}`
        );
      });
    }
  );

  req.on("error", (err) => {
    console.error("[card network] Failed to reach server — is server.js running?", err.message);
  });

  req.write(body);
  req.end();
}

console.log("Card network simulator started. Firing a random transaction every 4-8 seconds...");
console.log("Watch http://localhost:3000 to see benefit alerts appear with no manual input.\n");

// Fire one immediately, then keep firing on a random interval — just like
// real, unpredictable card swipes throughout the day.
fireTransaction();
setInterval(fireTransaction, 4000 + Math.random() * 4000);
