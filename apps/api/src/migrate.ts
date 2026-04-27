import { sql } from "./db.js";

async function migrate() {
  await sql`
    CREATE TABLE IF NOT EXISTS scores (
      id BIGSERIAL PRIMARY KEY,
      player TEXT NOT NULL,
      score INTEGER NOT NULL CHECK (score >= 0),
      max_tile INTEGER NOT NULL CHECK (max_tile >= 0),
      moves INTEGER NOT NULL CHECK (moves >= 0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS scores_score_idx ON scores (score DESC)`;

  await sql`
    CREATE TABLE IF NOT EXISTS games (
      id UUID PRIMARY KEY,
      player TEXT NOT NULL,
      board JSONB NOT NULL,
      score INTEGER NOT NULL,
      moves INTEGER NOT NULL,
      finished BOOLEAN NOT NULL DEFAULT FALSE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS games_player_idx ON games (player, updated_at DESC)`;

  console.log("migrations applied");
  await sql.end();
}

migrate().catch((err) => {
  console.error(err);
  process.exit(1);
});
