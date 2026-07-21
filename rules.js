/**
 * rules.js
 * The core "detection algorithm" for the Card Benefit Activation Engine.
 *
 * Each rule looks at a transaction and decides:
 *  - does this transaction qualify for a benefit?
 *  - which benefit type?
 *  - what's the claim window (expiry)?
 *  - what fields can we pre-fill on the claim form?
 *
 * MCC = Merchant Category Code, a 4-digit code every card transaction carries
 * that tells you what kind of merchant it was (electronics store, airline, etc).
 * This is the real-world signal issuers actually use for this kind of matching.
 */

// --- Reference data: which MCCs map to which benefit type ---
const PURCHASE_PROTECTION_MCCS = new Set([
  "5732", // Electronics stores
  "5712", // Furniture stores
  "5651", // Clothing stores
  "5945", // Toy stores
  "5734", // Computer software stores
  "5200", // Home supply / hardware
]);

const TRAVEL_MCCS = new Set([
  "3000", "3001", "3002", "3003", "3004", "3005", "3006", // major airlines block
  "4511", // airlines, air carriers (general)
  "4411", // cruise lines
]);

const RETURN_ELIGIBLE_MCCS = new Set([
  "5732", "5712", "5651", "5945", "5734", "5200", "5691", "5999",
]);

// --- Rule definitions: window length, min/max amount, benefit metadata ---
const RULES = {
  purchase_protection: {
    label: "Purchase Protection",
    windowDays: 120,
    minAmount: 25,
    maxCoverage: 10000,
    description:
      "Covers new purchases against accidental damage or theft for a limited time after purchase.",
  },
  return_protection: {
    label: "Return Protection",
    windowDays: 90,
    minAmount: 0,
    maxCoverage: 500,
    description:
      "Reimburses eligible items if the merchant won't accept a return within their return window.",
  },
  travel_delay: {
    label: "Travel Delay Insurance",
    windowDays: 365,
    minAmount: 0,
    maxCoverage: 500,
    description:
      "Reimburses reasonable expenses (meals, lodging) if your flight is delayed 6+ hours.",
  },
};

function addDays(dateStr, days) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Runs a single transaction through every rule and returns
 * an array of matched entitlements (can be zero, one, or more).
 */
function evaluateTransaction(tx) {
  const matches = [];
  const { mccCode, amount, date, merchantName, description } = tx;

  // --- Purchase Protection ---
  if (
    PURCHASE_PROTECTION_MCCS.has(mccCode) &&
    amount >= RULES.purchase_protection.minAmount
  ) {
    matches.push({
      benefitType: "purchase_protection",
      label: RULES.purchase_protection.label,
      reason: `Purchase of $${amount} at ${merchantName} (MCC ${mccCode}) qualifies for Purchase Protection.`,
      detectedAt: new Date().toISOString(),
      expiresAt: addDays(date, RULES.purchase_protection.windowDays),
      maxCoverage: Math.min(amount, RULES.purchase_protection.maxCoverage),
      prefill: {
        claimType: "Purchase Protection",
        itemDescription: description || merchantName,
        purchaseDate: date,
        purchaseAmount: amount,
        merchant: merchantName,
        cardUsed: tx.cardId,
        requestedAmount: amount,
      },
    });
  }

  // --- Return Protection ---
  if (
    RETURN_ELIGIBLE_MCCS.has(mccCode) &&
    amount >= RULES.return_protection.minAmount
  ) {
    matches.push({
      benefitType: "return_protection",
      label: RULES.return_protection.label,
      reason: `Purchase at ${merchantName} is eligible for Return Protection if the merchant refuses a return.`,
      detectedAt: new Date().toISOString(),
      expiresAt: addDays(date, RULES.return_protection.windowDays),
      maxCoverage: Math.min(amount, RULES.return_protection.maxCoverage),
      prefill: {
        claimType: "Return Protection",
        itemDescription: description || merchantName,
        purchaseDate: date,
        purchaseAmount: amount,
        merchant: merchantName,
        cardUsed: tx.cardId,
        requestedAmount: amount,
      },
    });
  }

  // --- Travel Delay Insurance ---
  if (TRAVEL_MCCS.has(mccCode)) {
    matches.push({
      benefitType: "travel_delay",
      label: RULES.travel_delay.label,
      reason: `Flight/travel purchase from ${merchantName} is eligible for Travel Delay coverage if delayed 6+ hours.`,
      detectedAt: new Date().toISOString(),
      expiresAt: addDays(date, RULES.travel_delay.windowDays),
      maxCoverage: RULES.travel_delay.maxCoverage,
      prefill: {
        claimType: "Travel Delay Insurance",
        flightMerchant: merchantName,
        purchaseDate: date,
        ticketAmount: amount,
        cardUsed: tx.cardId,
        requestedAmount: null, // needs delay hours / receipts from user
      },
    });
  }

  return matches;
}

module.exports = { evaluateTransaction, RULES };
