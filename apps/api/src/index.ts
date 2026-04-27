import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { z } from "zod";
import { sql } from "./db.js";

const app = new Hono();

const corsOrigin = process.env.CORS_ORIGIN ?? "*";
app.use("*", logger());
app.use(
  "*",
  cors({
    origin: corsOrigin === "*" ? "*" : corsOrigin.split(",").map((s) => s.trim()),
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  })
);

app.get("/", (c) => c.json({ name: "2048-api", ok: true }));
app.get("/health", async (c) => {
  try {
    await sql`SELECT 1`;
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ ok: false, error: String(err) }, 500);
  }
});

const scoreSchema = z.object({
  player: z.string().min(1).max(40),
  score: z.number().int().nonnegative(),
  max_tile: z.number().int().nonnegative(),
  moves: z.number().int().nonnegative(),
});

app.get("/api/scores", async (c) => {
  const limit = Math.min(Number(c.req.query("limit") ?? 10), 100);
  const rows = await sql`
    SELECT id, player, score, max_tile, moves, created_at
    FROM scores
    ORDER BY score DESC, created_at ASC
    LIMIT ${limit}
  `;
  return c.json({ scores: rows });
});

app.post("/api/scores", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = scoreSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "invalid payload", issues: parsed.error.issues }, 400);
  }
  const { player, score, max_tile, moves } = parsed.data;
  const [row] = await sql`
    INSERT INTO scores (player, score, max_tile, moves)
    VALUES (${player}, ${score}, ${max_tile}, ${moves})
    RETURNING id, player, score, max_tile, moves, created_at
  `;
  return c.json({ score: row }, 201);
});

const gameSchema = z.object({
  id: z.string().uuid(),
  player: z.string().min(1).max(40),
  board: z.array(z.array(z.number().int().nonnegative())).length(4),
  score: z.number().int().nonnegative(),
  moves: z.number().int().nonnegative(),
  finished: z.boolean().optional().default(false),
});

app.put("/api/games/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => null);
  const parsed = gameSchema.safeParse({ ...body, id });
  if (!parsed.success) {
    return c.json({ error: "invalid payload", issues: parsed.error.issues }, 400);
  }
  const { player, board, score, moves, finished } = parsed.data;
  const [row] = await sql`
    INSERT INTO games (id, player, board, score, moves, finished, updated_at)
    VALUES (${id}, ${player}, ${sql.json(board)}, ${score}, ${moves}, ${finished}, now())
    ON CONFLICT (id) DO UPDATE
      SET board = EXCLUDED.board,
          score = EXCLUDED.score,
          moves = EXCLUDED.moves,
          finished = EXCLUDED.finished,
          updated_at = now()
    RETURNING id, player, score, moves, finished, updated_at
  `;
  return c.json({ game: row });
});

app.get("/api/games/:id", async (c) => {
  const id = c.req.param("id");
  const [row] = await sql`
    SELECT id, player, board, score, moves, finished, updated_at
    FROM games WHERE id = ${id}
  `;
  if (!row) return c.json({ error: "not found" }, 404);
  return c.json({ game: row });
});

const port = Number(process.env.PORT ?? 8080);
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`api listening on http://localhost:${info.port}`);
});
