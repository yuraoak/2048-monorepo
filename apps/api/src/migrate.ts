import { sql } from "./db.js";

async function migrate() {
  // Idempotent bootstrap: creates tables/indexes on first run, no-ops on
  // subsequent runs. Safe to invoke on every redeploy without wiping data.
  // NOTE: this only handles fresh creation. Altering an existing table's
  // schema (new columns, changed types, etc.) requires a real migration
  // step — add it below as an explicit ALTER guarded by IF NOT EXISTS /
  // information_schema checks, not by editing the CREATE block.
  await sql`
    CREATE TABLE IF NOT EXISTS scores (
      fid BIGINT PRIMARY KEY,
      username TEXT,
      pfp_url TEXT,
      score INTEGER NOT NULL CHECK (score >= 0),
      max_tile INTEGER NOT NULL CHECK (max_tile >= 0),
      moves INTEGER NOT NULL CHECK (moves >= 0),
      final_board JSONB,
      final_score INTEGER,
      final_max_tile INTEGER,
      seed BIGINT,
      move_log TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS scores_score_idx ON scores (score DESC)`;

  // Server-authoritative active game per fid. The pair (seed, move_log) fully
  // reproduces the board + score via deterministic replay, so we don't store
  // the board itself.
  await sql`
    CREATE TABLE IF NOT EXISTS active_games (
      fid BIGINT PRIMARY KEY,
      seed BIGINT NOT NULL,
      move_log TEXT NOT NULL DEFAULT '',
      finished BOOLEAN NOT NULL DEFAULT FALSE,
      started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;

  // Per-fid undo credit balance. Topped up by purchasing packs (small/
  // medium/large) and spent one-at-a-time by /api/games/undo. Lives in
  // Postgres rather than Redis — this is paid balance, durability matters.
  await sql`
    CREATE TABLE IF NOT EXISTS undo_credits (
      fid BIGINT PRIMARY KEY,
      balance INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;

  // One row per consumed on-chain pack purchase. tx_hash as PK prevents
  // reuse; pack_id and undos_credited capture which pack the tx bought
  // (small=3, medium=15, large=100) so we can audit topups.
  await sql`
    CREATE TABLE IF NOT EXISTS undo_payments (
      tx_hash TEXT PRIMARY KEY,
      fid BIGINT NOT NULL,
      pack_id TEXT NOT NULL,
      undos_credited INTEGER NOT NULL,
      amount_wei NUMERIC(78) NOT NULL,
      block_number BIGINT NOT NULL,
      used_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS undo_payments_fid_idx ON undo_payments (fid)`;

  // Durable record of every pack-purchase intent. Mirrors the ephemeral
  // Redis entry written by /api/shop/packs/intent so the Go reconciler can
  // still resolve (nonce → fid, pack) after Redis TTL expires. The hot
  // /buy path keeps reading from Redis; this table only matters when the
  // user pays but never pings /buy (closed app, network drop, etc.) — the
  // reconciler picks the orphan up by scanning the treasury.
  await sql`
    CREATE TABLE IF NOT EXISTS pack_intents (
      nonce BIGINT PRIMARY KEY,
      fid BIGINT NOT NULL,
      pack_id TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS pack_intents_fid_idx ON pack_intents (fid)`;

  // Single-row table tracking the last Base block fully scanned by the
  // reconciler worker. A primary key check pins it to id=1.
  await sql`
    CREATE TABLE IF NOT EXISTS reconciler_cursor (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      last_block BIGINT NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await sql`
    INSERT INTO reconciler_cursor (id, last_block)
    VALUES (1, 0)
    ON CONFLICT (id) DO NOTHING
  `;

  // One row per Farcaster share. The id is the path segment of the public
  // /share/:id page (which renders fc:miniapp meta with image_url so the cast
  // gets a rich preview). Snapshotted score/rank/max_tile lock the displayed
  // values at share time.
  await sql`
    CREATE TABLE IF NOT EXISTS shares (
      id TEXT PRIMARY KEY,
      fid BIGINT NOT NULL,
      score INTEGER NOT NULL,
      rank INTEGER,
      max_tile INTEGER NOT NULL,
      image_url TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS shares_fid_idx ON shares (fid, created_at DESC)`;

  console.log("migrations applied");
  await sql.end();
}

migrate().catch((err) => {
  console.error(err);
  process.exit(1);
});
