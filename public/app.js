// ═══════════════════════════════════════════════
// CLAIMED BENEFITS HISTORY
// ═══════════════════════════════════════════════
const historyListEl = document.getElementById("historyList");
const historyCountEl = document.getElementById("historyCount");
const statTotalEl = document.getElementById("statTotal");
const statClaimedEl = document.getElementById("statClaimed");
const statPendingEl = document.getElementById("statPending");
const statCoverageEl = document.getElementById("statCoverage");
const filterBar = document.getElementById("filterBar");
const historyToggle = document.getElementById("historyToggle");
const historySection = document.getElementById("historySection");

let allBenefitsHistory = [];
let currentFilter = "all";
let knownBenefitIds = new Set();
let lastDataHash = "";

// Toggle collapse
historyToggle.addEventListener("click", () => {
  historySection.classList.toggle("collapsed");
  const collapsed = historySection.classList.contains("collapsed");
  historyToggle.textContent = collapsed ? "▶ Expand" : "▼ Collapse";
});

// Filter tabs
filterBar.addEventListener("click", (e) => {
  if (!e.target.classList.contains("filter-tab")) return;
  filterBar.querySelectorAll(".filter-tab").forEach(t => t.classList.remove("active"));
  e.target.classList.add("active");
  currentFilter = e.target.dataset.filter;
  renderHistory(allBenefitsHistory);
});

function getBenefitIcon(type) {
  switch (type) {
    case "purchase_protection": return "🛡️";
    case "return_protection": return "↩️";
    case "travel_delay": return "✈️";
    default: return "📋";
  }
}

function getBenefitIconClass(type) {
  switch (type) {
    case "purchase_protection": return "purchase";
    case "return_protection": return "return";
    case "travel_delay": return "travel";
    default: return "purchase";
  }
}

function getStatusBadge(item) {
  if (item.claimId || item.status === "submitted") {
    return `<span class="status-badge claimed">Claimed</span>`;
  }
  const expiry = new Date(item.expiresAt);
  if (expiry < new Date()) {
    return `<span class="status-badge expired">Expired</span>`;
  }
  return `<span class="status-badge detected">Pending</span>`;
}

function formatDate(isoStr) {
  if (!isoStr) return "—";
  const d = new Date(isoStr);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function formatCurrency(val) {
  return "$" + Number(val).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function computeDataHash(data) {
  return JSON.stringify(data.map(d => d.id + (d.claimId || "") + d.status));
}

function renderHistory(data) {
  let filtered = data;
  if (currentFilter === "submitted") {
    filtered = data.filter(d => d.claimId || d.status === "submitted");
  } else if (currentFilter !== "all") {
    filtered = data.filter(d => d.benefitType === currentFilter);
  }

  if (filtered.length === 0) {
    historyListEl.innerHTML = `
      <div class="history-empty">
        <div class="empty-icon">📭</div>
        ${data.length === 0 
          ? "No benefits detected yet. Run the simulator or submit a transaction." 
          : "No benefits match this filter."}
      </div>`;
    return;
  }

  historyListEl.innerHTML = filtered.map(item => {
    const isNew = !knownBenefitIds.has(item.id);
    if (isNew) knownBenefitIds.add(item.id);
    return `
    <div class="history-item${isNew ? ' new-item' : ''}">
      <div class="history-icon ${getBenefitIconClass(item.benefitType)}">${getBenefitIcon(item.benefitType)}</div>
      <div class="history-info">
        <div class="history-label">${item.label}</div>
        <div class="history-merchant">${item.merchantName} · ${formatDate(item.purchaseDate)} · ${item.cardId}</div>
      </div>
      <div class="history-amount">
        <div class="amount-value">$${Number(item.amount).toFixed(2)}</div>
        <div class="amount-sub">up to ${formatCurrency(item.maxCoverage)}</div>
      </div>
      <div class="history-status">${getStatusBadge(item)}</div>
    </div>`;
  }).join("");

  // Clean up new-item animation class after animation completes
  requestAnimationFrame(() => {
    historyListEl.querySelectorAll('.history-item.new-item').forEach(el => {
      setTimeout(() => el.classList.remove('new-item'), 400);
    });
  });
}

function updateStats(data) {
  const total = data.length;
  const claimed = data.filter(d => d.claimId || d.status === "submitted").length;
  const expired = data.filter(d => {
    const exp = new Date(d.expiresAt);
    return exp < new Date() && !d.claimId && d.status !== "submitted";
  }).length;
  const pending = total - claimed - expired;
  const totalCoverage = data.reduce((sum, d) => sum + (d.maxCoverage || 0), 0);

  statTotalEl.textContent = total;
  statClaimedEl.textContent = claimed;
  statPendingEl.textContent = pending;
  statCoverageEl.textContent = formatCurrency(totalCoverage);
  historyCountEl.textContent = total;
}

async function fetchBenefitsHistory() {
  try {
    const res = await fetch("/api/benefits-history");
    const data = await res.json();
    const newHash = computeDataHash(data);
    const dataChanged = newHash !== lastDataHash;
    allBenefitsHistory = data;
    updateStats(data);
    if (dataChanged) {
      lastDataHash = newHash;
      renderHistory(data);
    }
  } catch (err) {
    console.error("Failed to fetch benefits history:", err);
  }
}

// Initial load + refresh every 5s
fetchBenefitsHistory();
setInterval(fetchBenefitsHistory, 5000);


// ═══════════════════════════════════════════════
// EXISTING LIVE BENEFIT FEED LOGIC
// ═══════════════════════════════════════════════
const form = document.getElementById("txForm");
const alertsEl = document.getElementById("alerts");
const txLogEl = document.getElementById("txLog");
document.getElementById("date").valueAsDate = new Date();

const CARD_ID = "card_001"; // in a real app this comes from the logged-in user's session
const seenEntitlementIds = new Set();

// --- Passive listening loop ---
// This is the piece that replicates real life: the dashboard doesn't wait
// for a form submit. It polls the backend (or in production, would hold a
// WebSocket / push subscription open) and renders any NEW benefit the
// engine has detected — even if it came from the automated simulator/webhook
// and no human touched this page at all.
async function pollForNewBenefits() {
  try {
    const res = await fetch(`/api/entitlements?cardId=${CARD_ID}`);
    const entitlements = await res.json();

    const fresh = entitlements.filter(e => !seenEntitlementIds.has(e.id));
    if (fresh.length > 0) {
      if (alertsEl.querySelector(".empty")) alertsEl.innerHTML = "";
      fresh.forEach(ent => {
        seenEntitlementIds.add(ent.id);
        renderAlert(ent);
      });
    }
  } catch (err) {
    console.error("Polling failed:", err);
  }
}
setInterval(pollForNewBenefits, 2000); // check every 2s, like a live feed
pollForNewBenefits();

const presets = {
  electronics: { merchantName: "Best Buy", mccCode: "5732", amount: 899.00, description: "55in Smart TV" },
  flight: { merchantName: "United Airlines", mccCode: "3000", amount: 450.00, description: "Round-trip flight" },
  coffee: { merchantName: "Local Coffee Shop", mccCode: "5814", amount: 4.50, description: "Latte" },
};

document.querySelectorAll(".preset-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    const p = presets[btn.dataset.preset];
    document.getElementById("merchantName").value = p.merchantName;
    document.getElementById("mccCode").value = p.mccCode;
    document.getElementById("amount").value = p.amount;
    document.getElementById("description").value = p.description;
  });
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();

  const payload = {
    cardId: document.getElementById("cardId").value,
    merchantName: document.getElementById("merchantName").value,
    mccCode: document.getElementById("mccCode").value,
    amount: parseFloat(document.getElementById("amount").value),
    date: document.getElementById("date").value,
    description: document.getElementById("description").value,
  };

  const res = await fetch("/api/transactions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json();

  logTransaction(payload, data.benefitsDetected);

  // Mark these as already-seen so the polling loop (which is the "real"
  // real-time path) doesn't render them a second time.
  if (data.benefitsDetected > 0) {
    if (alertsEl.querySelector(".empty")) alertsEl.innerHTML = "";
    data.entitlements.forEach(ent => {
      seenEntitlementIds.add(ent.id);
      renderAlert(ent);
    });
  } else {
    flashNoMatch();
  }

  // Also refresh the history section immediately
  fetchBenefitsHistory();

  document.getElementById("merchantName").value = "";
  document.getElementById("mccCode").value = "";
  document.getElementById("amount").value = "";
  document.getElementById("description").value = "";
});

function logTransaction(tx, matchCount) {
  const row = document.createElement("div");
  row.textContent = `${tx.merchantName} — $${tx.amount} (MCC ${tx.mccCode}) → ${matchCount} benefit(s) matched`;
  txLogEl.prepend(row);
}

function flashNoMatch() {
  const div = document.createElement("div");
  div.className = "alert-card";
  div.style.borderColor = "#3a3f4a";
  div.innerHTML = `<p class="reason" style="margin:0;">No eligible benefits found for that transaction (MCC not covered by any active rule).</p>`;
  alertsEl.prepend(div);
  setTimeout(() => div.remove(), 3500);
}

function renderAlert(ent) {
  const card = document.createElement("div");
  card.className = "alert-card";

  const prefillRows = Object.entries(ent.prefill)
    .map(([k, v]) => `<div><span>${labelize(k)}</span><span>${v ?? "—"}</span></div>`)
    .join("");

  card.innerHTML = `
    <div class="alert-top">
      <span class="badge">Benefit Detected</span>
      <span class="expiry">Claim by ${ent.expiresAt}</span>
    </div>
    <h3>${ent.label}</h3>
    <p class="reason">${ent.reason}</p>
    <div class="prefill">${prefillRows}</div>
    <button class="claim-btn">File Pre-Filled Claim</button>
  `;

  card.querySelector(".claim-btn").addEventListener("click", async (btnEvent) => {
    const btn = btnEvent.target;
    btn.disabled = true;
    btn.textContent = "Submitting...";
    const res = await fetch("/api/claims", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entitlementId: ent.id, fields: {} }),
    });
    if (res.ok) {
      btn.textContent = "✓ Claim Submitted";
      // Refresh history to show the newly claimed benefit
      fetchBenefitsHistory();
    } else {
      btn.textContent = "Failed — retry";
      btn.disabled = false;
    }
  });

  alertsEl.prepend(card);
}

function labelize(key) {
  return key.replace(/([A-Z])/g, " $1").replace(/^./, s => s.toUpperCase());
}