-- schema.sql
-- Run this once against your Supabase / Postgres database before starting the server.
-- In Supabase: Dashboard -> SQL Editor -> paste this -> Run.

CREATE TABLE IF NOT EXISTS transactions (
  id             UUID PRIMARY KEY,
  card_id        TEXT NOT NULL,
  merchant_name  TEXT NOT NULL,
  mcc_code       TEXT NOT NULL,
  amount         NUMERIC(12,2) NOT NULL CHECK (amount >= 0),
  purchase_date  DATE NOT NULL,
  description    TEXT DEFAULT '',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS entitlements (
  id             UUID PRIMARY KEY,
  transaction_id UUID NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  benefit_type   TEXT NOT NULL,          -- purchase_protection | return_protection | travel_delay
  label          TEXT NOT NULL,
  reason         TEXT NOT NULL,
  detected_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at     DATE NOT NULL,
  max_coverage   NUMERIC(12,2) NOT NULL,
  prefill        JSONB NOT NULL,
  status         TEXT NOT NULL DEFAULT 'detected'  -- detected | notified | submitted | approved | denied
);

CREATE TABLE IF NOT EXISTS claims (
  id             UUID PRIMARY KEY,
  entitlement_id UUID NOT NULL REFERENCES entitlements(id) ON DELETE CASCADE,
  fields         JSONB NOT NULL,
  status         TEXT NOT NULL DEFAULT 'submitted', -- submitted | under_review | approved | denied | paid
  submitted_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Helpful indexes for the queries server.js actually runs
CREATE INDEX IF NOT EXISTS idx_transactions_card_id ON transactions(card_id);
CREATE INDEX IF NOT EXISTS idx_entitlements_transaction_id ON entitlements(transaction_id);
CREATE INDEX IF NOT EXISTS idx_claims_entitlement_id ON claims(entitlement_id);
