import { pool } from "../../../lib/db/src/index.ts";

export async function ensureDatabaseSchema() {
  await pool.query(`
    ALTER TABLE holdings
      ADD COLUMN IF NOT EXISTS cost_of_capital numeric(18, 2),
      ADD COLUMN IF NOT EXISTS interest numeric(18, 2)
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS transactions (
      id serial PRIMARY KEY,
      side text NOT NULL,
      origin text NOT NULL DEFAULT 'manual',
      funding_source text NOT NULL,
      asset_type text NOT NULL,
      symbol text NOT NULL,
      quantity numeric(18, 6) NOT NULL,
      total_value numeric(18, 2) NOT NULL,
      unit_price numeric(18, 2),
      realized_interest numeric(18, 2),
      note text,
      status text NOT NULL DEFAULT 'recorded',
      executed_at timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  await pool.query(`
    ALTER TABLE transactions
      ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'manual'
  `);

  await pool.query(`
    ALTER TABLE transactions
      ADD COLUMN IF NOT EXISTS gross_amount numeric(18, 2),
      ADD COLUMN IF NOT EXISTS fee numeric(18, 2),
      ADD COLUMN IF NOT EXISTS tax numeric(18, 2),
      ADD COLUMN IF NOT EXISTS net_amount numeric(18, 2)
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS portfolio_cash_flows (
      id serial PRIMARY KEY,
      kind text NOT NULL DEFAULT 'contribution',
      account text NOT NULL DEFAULT 'CASH',
      origin text NOT NULL DEFAULT 'manual',
      amount numeric(18, 2) NOT NULL,
      note text,
      source text NOT NULL DEFAULT 'manual',
      occurred_at timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  await pool.query(`
    ALTER TABLE portfolio_cash_flows
      ADD COLUMN IF NOT EXISTS account text NOT NULL DEFAULT 'CASH',
      ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'manual'
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS price_history (
      id serial PRIMARY KEY,
      date timestamptz NOT NULL DEFAULT now(),
      asset_code text NOT NULL,
      asset_type text NOT NULL,
      price_or_value numeric(22, 2) NOT NULL,
      quantity numeric(18, 6),
      current_value numeric(22, 2),
      source text NOT NULL DEFAULT 'manual',
      note text,
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS price_history_asset_date_idx
      ON price_history (asset_code, date DESC)
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS forecast_trades (
      id serial PRIMARY KEY,
      side text NOT NULL,
      year integer NOT NULL,
      asset_type text NOT NULL,
      symbol text NOT NULL,
      amount numeric(18, 2) NOT NULL,
      loan_ratio numeric(10, 6) NOT NULL DEFAULT 0,
      loan_interest_rate numeric(10, 6) NOT NULL DEFAULT 0,
      loan_annual_principal_payment numeric(18, 2) NOT NULL DEFAULT 0,
      loan_annual_interest_payment numeric(18, 2) NOT NULL DEFAULT 0,
      loan_repayment_type text NOT NULL DEFAULT 'interest_only',
      settle_loan_on_sell boolean NOT NULL DEFAULT true,
      note text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  await pool.query(`
    ALTER TABLE forecast_trades
      ADD COLUMN IF NOT EXISTS loan_ratio numeric(10, 6) NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS loan_interest_rate numeric(10, 6) NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS loan_annual_principal_payment numeric(18, 2) NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS loan_annual_interest_payment numeric(18, 2) NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS loan_repayment_type text NOT NULL DEFAULT 'interest_only',
      ADD COLUMN IF NOT EXISTS settle_loan_on_sell boolean NOT NULL DEFAULT true
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS forecast_trades_year_idx
      ON forecast_trades (year)
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS base_assets (
      id serial PRIMARY KEY,
      asset_type text NOT NULL,
      symbol text NOT NULL,
      base_year integer NOT NULL DEFAULT 2026,
      base_value numeric(22, 2) NOT NULL,
      assumed_return_rate numeric(10, 6) NOT NULL DEFAULT 0,
      note text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS base_assets_year_type_idx
      ON base_assets (base_year, asset_type)
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS forecast_loans (
      id serial PRIMARY KEY,
      asset_type text NOT NULL,
      asset_symbol text NOT NULL,
      loan_name text NOT NULL,
      principal_start numeric(18, 2) NOT NULL,
      interest_rate numeric(10, 6) NOT NULL DEFAULT 0,
      start_year integer NOT NULL,
      end_year integer,
      repayment_type text NOT NULL DEFAULT 'interest_only',
      annual_principal_payment numeric(18, 2) NOT NULL DEFAULT 0,
      annual_interest_payment numeric(18, 2) NOT NULL DEFAULT 0,
      settle_on_asset_sell boolean NOT NULL DEFAULT true,
      status text NOT NULL DEFAULT 'active',
      note text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS forecast_loans_asset_name_start_year_idx
      ON forecast_loans (asset_symbol, loan_name, start_year)
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS forecast_loan_events (
      id serial PRIMARY KEY,
      loan_id integer NOT NULL REFERENCES forecast_loans(id) ON DELETE CASCADE,
      year integer NOT NULL,
      event_type text NOT NULL,
      amount numeric(18, 2) NOT NULL,
      source text NOT NULL DEFAULT 'manual',
      trade_id integer,
      note text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS forecast_loan_events_loan_year_idx
      ON forecast_loan_events (loan_id, year)
  `);

  await pool.query(`
    INSERT INTO forecast_loans (
      asset_type,
      asset_symbol,
      loan_name,
      principal_start,
      interest_rate,
      start_year,
      repayment_type,
      annual_principal_payment,
      annual_interest_payment,
      settle_on_asset_sell,
      status,
      note
    )
    VALUES
      (
        'Real Estate',
        'Ariyana',
        'Ariyana loan',
        1285292000,
        0,
        2026,
        'interest_only',
        0,
        0,
        true,
        'active',
        'Forecast seed. Interest is already represented in Function.total interest; principal schedule is not connected yet.'
      ),
      (
        'Business',
        'Shop Mẹ & Bé',
        'Shop Mẹ & Bé loan',
        347488000,
        0,
        2026,
        'interest_only',
        0,
        0,
        true,
        'active',
        'Forecast seed. Interest is already represented in Function.total interest; principal schedule is not connected yet.'
      )
    ON CONFLICT (asset_symbol, loan_name, start_year) DO NOTHING
  `);
}
