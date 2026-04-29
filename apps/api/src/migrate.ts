import { sql } from "./db.js";

async function migrate() {
  // Old client-trusted score submission was replaced with server-authoritative
  // (seed, move_log) state, plus an undo flow gated by on-chain payments.
  // We replace the tables that changed shape and leave `scores` alone.
  console.warn("dropping legacy game-state tables");
  await sql`DROP TABLE IF EXISTS games CASCADE`;
  await sql`DROP TABLE IF EXISTS active_games CASCADE`;
  await sql`DROP TABLE IF EXISTS undo_payments CASCADE`;

  await sql`
    CREATE TABLE IF NOT EXISTS scores (
      fid BIGINT PRIMARY KEY,
      username TEXT,
      pfp_url TEXT,
      score INTEGER NOT NULL CHECK (score >= 0),
      max_tile INTEGER NOT NULL CHECK (max_tile >= 0),
      moves INTEGER NOT NULL CHECK (moves >= 0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS scores_score_idx ON scores (score DESC)`;

  // Server-authoritative active game per fid. The pair (seed, move_log) fully
  // reproduces the board + score via deterministic replay, so we don't store
  // the board itself.
  await sql`
    CREATE TABLE active_games (
      fid BIGINT PRIMARY KEY,
      seed BIGINT NOT NULL,
      move_log TEXT NOT NULL DEFAULT '',
      finished BOOLEAN NOT NULL DEFAULT FALSE,
      started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;

  // One row per consumed on-chain undo payment. tx_hash as PK prevents reuse.
  await sql`
    CREATE TABLE undo_payments (
      tx_hash TEXT PRIMARY KEY,
      fid BIGINT NOT NULL,
      amount_wei NUMERIC(78) NOT NULL,
      block_number BIGINT NOT NULL,
      used_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await sql`CREATE INDEX undo_payments_fid_idx ON undo_payments (fid)`;

  console.log("migrations applied");
  await sql.end();
}

migrate().catch((err) => {
  console.error(err);
  process.exit(1);
});
