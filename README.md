# Card Benefit Activation Engine

Detects when a card transaction qualifies for an unused insurance/protection
benefit (purchase protection, return protection, travel delay insurance) and
pre-fills the claim automatically, so card members never miss a benefit
they've already paid for.

## Project structure

```
benefit-engine/
├── server.js        # Backend — routes, Supabase PostgreSQL DB queries, webhook + test endpoints
├── db.js            # PostgreSQL connection pool configuration
├── rules.js         # The detection algorithm (MCC matching, claim windows, pre-fill logic)
├── simulator.js     # Stands in for the card network — auto-fires transactions
├── package.json
└── public/
└── index.html   # Dashboard — shows detected benefits, pre-filled claims
```

## The architecture

`server.js` has two entry points, and this split is the important part:

- **`POST /api/transactions`** — the manual test form (dev-only, for you to
  poke the engine by hand).
- **`POST /api/webhooks/transactions`** — the real entry point. This is
  shaped exactly like a Stripe Issuing `issuing_authorization.created`
  webhook event. In production, Stripe (or your bank's processor) calls this
  automatically the instant someone swipes their card — no human involved.

**`db.js`** handles the connection to a cloud **Supabase PostgreSQL** database, where all `transactions`, `entitlements`, and `claims` are persisted in real time.

**`simulator.js`** is a standalone script that plays the role of "the card
network." It randomly picks a merchant/card every 4–8 seconds and POSTs a
realistic authorization event to the webhook, just like real, unpredictable
spending throughout a person's day.

**`public/index.html`** is the dashboard. It polls every 2 seconds for new
entitlements instead of only reacting to a form submit. This stands in for
what would be a push notification or WebSocket subscription in a real app —
the person just sees alerts appear on their own.

## Running it

### 1. Installation & Environment Setup

Install the required PostgreSQL and environment dependencies:

```bash
npm install
```
### 2. Create a .env file in the root directory and add your Supabase connection URL:
```bash
DATABASE_URL=postgresql://postgres.[PROJECT-REF]:[YOUR-PASSWORD]@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres
```

## Start the Application
Open **two terminals** in the project folder:

**Terminal 1** — starts the backend:
```bash
node server.js
```

**Terminal 2** — plays the role of Visa/Stripe/your bank, firing transactions automatically:
```bash
node simulator.js
```

Then open **http://localhost:3000** and watch. Benefit alerts will appear on
their own every few seconds — nothing needs to be typed. The dev test form
on the dashboard is available if you want to trigger a specific transaction
by hand instead of waiting on the simulator.

## Mapping this demo to a real production deploy

| This demo | Real production |
|---|---|
| `simulator.js` | Stripe Issuing / Marqeta / bank core sending real webhooks |
| Dashboard polling every 2s | WebSocket or push notification (APNs/FCM) |
| Manual test form | Removed entirely, or dev-only behind auth |
| Supabase PostgreSQL | Managed PostgreSQL / AWS DynamoDB / MySQL |
| Direct webhook call | Kafka / Pub-Sub topic, so multiple services (fraud, rewards, this engine) can consume the same transaction stream independently |
