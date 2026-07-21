# codestreet-card-engine

The architecture

server.js now has two entry points, and this split is the important part:

POST /api/transactions — the manual test form (dev-only, for you to poke the engine by hand)
POST /api/webhooks/transactions — the real entry point. This is shaped exactly like a Stripe Issuing issuing_authorization.created webhook event. In production, Stripe (or your bank's processor) calls this automatically the instant someone swipes their card — no human involved.

simulator.js — a new standalone script that plays the role of "the card network." It randomly picks a merchant/card every 4-8 seconds and POSTs a realistic authorization event to the webhook, just like real, unpredictable spending throughout a person's day.

public/index.html — the dashboard now polls every 2 seconds for new entitlements instead of only reacting to a form submit. This is standing in for what would be a push notification or WebSocket subscription in a real app — the person just sees alerts appear on their own.


Open two terminals in the project folder:


Terminal 1:
node server.js

Terminal 2 — this plays the role of Visa/Stripe/your bank
node simulator.js

