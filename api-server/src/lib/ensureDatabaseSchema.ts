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
      note text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS forecast_trades_year_idx
      ON forecast_trades (year)
  `);
}
