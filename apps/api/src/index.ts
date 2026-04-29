import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { z } from "zod";
import { sql } from "./db.js";
import { farcasterAuth } from "./auth.js";
import { cacheGet, cacheSet, cacheInvalidatePattern, rateLimit, redis } from "./cache.js";
import { replay } from "./replay.js";
import { treasuryAddress, undoPriceWei, verifyUndoPayment } from "./onchain.js";
import {
  casAppend,
  casPop,
  getGame,
  markFinished,
  setGame,
  type ActiveGame,
} from "./gameStore.js";

const SCORES_CACHE_TTL = 15;
const SCORE_SUBMIT_LIMIT = 5;
const SCORE_SUBMIT_WINDOW = 60;
const MOVE_LIMIT = 240;
const MOVE_WINDOW = 60;
const UNDO_LIMIT = 10;
const UNDO_WINDOW = 60;

type AppEnv = { Variables: { fid: number } };
const app = new Hono<AppEnv>();

const corsOrigin = process.env.CORS_ORIGIN ?? "*";
app.use("*", logger());
app.use(
  "*",
  cors({
    origin: corsOrigin === "*" ? "*" : corsOrigin.split(",").map((s) => s.trim()),
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
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

app.get("/api/config", (c) =>
  c.json({
    treasury: treasuryAddress,
    undo_price_wei: undoPriceWei.toString(),
    chain_id: 8453,
  })
);

app.get("/api/scores/me", farcasterAuth, async (c) => {
  const fid = c.get("fid");
  const [row] = await sql`
    SELECT fid, username, pfp_url, score, max_tile, moves, updated_at
    FROM scores WHERE fid = ${fid}
  `;
  if (!row) return c.json({ score: null }, 404);
  return c.json({ score: row });
});

app.get("/api/scores", async (c) => {
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 20), 1), 100);
  const offset = Math.max(Number(c.req.query("offset") ?? 0), 0);
  const cacheKey = `scores:top:${limit}:${offset}`;

  const cached = await cacheGet<{ scores: unknown[] }>(cacheKey);
  if (cached) {
    c.header("X-Cache", "HIT");
    return c.json(cached);
  }

  const rows = await sql`
    SELECT fid, username, pfp_url, score, max_tile, moves, updated_at
    FROM scores
    ORDER BY score DESC, updated_at ASC
    LIMIT ${limit} OFFSET ${offset}
  `;
  const payload = { scores: rows };
  await cacheSet(cacheKey, payload, SCORES_CACHE_TTL);
  c.header("X-Cache", "MISS");
  return c.json(payload);
});

// ---- Server-authoritative game state (Redis-backed) ----

function projectState(game: ActiveGame) {
  const r = replay(game.seed, game.move_log);
  return {
    seed: game.seed,
    board: r.board,
    score: r.score,
    max_tile: r.max_tile,
    moves: r.moves,
    move_log: game.move_log,
    log_len: game.move_log.length,
    over: r.over,
    finished: game.finished,
  };
}

// Lite projection used in hot-path /move responses: omits move_log to keep
// payloads small. Client only needs log_len for sync; if it ever needs the
// full log (rare desync) it falls back to /api/games/state.
function projectStateLite(game: ActiveGame) {
  const full = projectState(game);
  const { move_log: _omit, ...lite } = full;
  void _omit;
  return lite;
}

app.post("/api/games/start", farcasterAuth, async (c) => {
  const fid = c.get("fid");
  const seed = Math.floor(Math.random() * 0xffffffff);
  const game: ActiveGame = { seed, move_log: "", finished: false };
  await setGame(fid, game);
  return c.json({ state: projectState(game) });
});

app.post("/api/games/state", farcasterAuth, async (c) => {
  const fid = c.get("fid");
  const game = await getGame(fid);
  if (!game) return c.json({ state: null });
  return c.json({ state: projectState(game) });
});

const moveSchema = z.object({
  dirs: z.string().min(1).max(64).regex(/^[udlr]+$/),
  expectedLen: z.number().int().nonnegative(),
});

app.post("/api/games/move", farcasterAuth, async (c) => {
  const fid = c.get("fid");

  const allowed = await rateLimit(`ratelimit:move:${fid}`, MOVE_LIMIT, MOVE_WINDOW);
  if (!allowed) return c.json({ error: "too many requests" }, 429);

  const body = await c.req.json().catch(() => null);
  const parsed = moveSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "invalid payload", issues: parsed.error.issues }, 400);
  }
  const { dirs, expectedLen } = parsed.data;

  const game = await getGame(fid);
  if (!game) return c.json({ error: "no active game" }, 404);
  if (game.finished) {
    return c.json({ error: "game finished", state: projectStateLite(game) }, 409);
  }

  const current = projectStateLite(game);
  if (current.over) return c.json({ error: "game over", state: current }, 409);
  if (current.log_len !== expectedLen) {
    return c.json({ error: "expected_len_mismatch", state: current }, 409);
  }

  // Apply each requested move on the server's authoritative board, accepting
  // only those that actually move pieces and stopping when the game is over.
  // This lets the client batch a burst of inputs into a single round-trip.
  let acceptedLog = game.move_log;
  let probeMoves = current.moves;
  let probeOver: boolean = current.over;
  for (const ch of dirs) {
    if (probeOver) break;
    const candidate = acceptedLog + ch;
    const next = replay(game.seed, candidate);
    if (next.moves === probeMoves) continue; // no-op
    acceptedLog = candidate;
    probeMoves = next.moves;
    probeOver = next.over;
  }
  if (acceptedLog === game.move_log) {
    return c.json({ error: "no-op batch", state: current }, 400);
  }

  const cas = await casAppend(fid, expectedLen, acceptedLog);
  if (!cas.ok) {
    return c.json({
      error: cas.reason,
      state: cas.game ? projectStateLite(cas.game) : null,
    }, 409);
  }
  return c.json({ state: projectStateLite(cas.game) });
});

// Intent-based undo payment binding.
// Calldata-based fid binding fails on some smart-wallet implementations
// (Farcaster's embedded wallet drops `data` on simple ETH transfers). We
// instead encode fid binding via a unique-per-user `value`: the server hands
// out an intent id (a monotonically-increasing nonce) and the client pays
// `BASE_PRICE + nonce` wei. Server extracts the nonce back from the on-chain
// tx.value and looks up which fid the intent belongs to.

const INTENT_TTL_SEC = 600;
const intentKey = (nonce: number) => `undo:intent:${nonce}`;
const INTENT_COUNTER_KEY = "undo:intent:counter";

app.post("/api/games/undo/intent", farcasterAuth, async (c) => {
  const fid = c.get("fid");
  if (!redis) return c.json({ error: "redis unavailable" }, 503);

  const allowed = await rateLimit(`ratelimit:intent:${fid}`, UNDO_LIMIT, UNDO_WINDOW);
  if (!allowed) return c.json({ error: "too many requests" }, 429);

  const nonce = await redis.incr(INTENT_COUNTER_KEY);
  await redis.set(intentKey(nonce), JSON.stringify({ fid }), "EX", INTENT_TTL_SEC);

  const amountWei = undoPriceWei + BigInt(nonce);
  return c.json({
    nonce,
    amount_wei: amountWei.toString(),
    treasury: treasuryAddress,
    expires_in_sec: INTENT_TTL_SEC,
  });
});

const undoSchema = z.object({
  txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
});

app.post("/api/games/undo", farcasterAuth, async (c) => {
  const fid = c.get("fid");

  const allowed = await rateLimit(`ratelimit:undo:${fid}`, UNDO_LIMIT, UNDO_WINDOW);
  if (!allowed) return c.json({ error: "too many requests" }, 429);

  const body = await c.req.json().catch(() => null);
  const parsed = undoSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "invalid payload" }, 400);
  }
  const txHash = parsed.data.txHash.toLowerCase();

  if (!redis) return c.json({ error: "redis unavailable" }, 503);

  // 1. Verify the on-chain payment (treasury + min value + confirmations).
  let payment;
  try {
    payment = await verifyUndoPayment(txHash);
  } catch (err) {
    return c.json({ error: "payment verification failed", detail: String(err) }, 400);
  }

  // 2. Decode the intent nonce embedded in tx.value and verify it belongs to
  // the requesting fid. Without this check, anyone could spend any
  // already-mined tx hash; with it, replays from another user fail.
  const diff = payment.amountWei - undoPriceWei;
  if (diff < 0n || diff > BigInt(Number.MAX_SAFE_INTEGER)) {
    return c.json({ error: "amount out of range" }, 400);
  }
  const nonce = Number(diff);
  const intentRaw = await redis.get(intentKey(nonce));
  if (!intentRaw) return c.json({ error: "intent expired or unknown" }, 400);
  const intent = JSON.parse(intentRaw) as { fid: number };
  if (intent.fid !== fid) return c.json({ error: "intent mismatch" }, 400);

  // 3. Claim tx_hash in Postgres (PK enforces one-time use). If the Redis
  // pop later fails, we'll roll this row back so the tx is retryable.
  try {
    await sql`
      INSERT INTO undo_payments (tx_hash, fid, amount_wei, block_number)
      VALUES (${txHash}, ${fid}, ${payment.amountWei.toString()}, ${payment.blockNumber})
    `;
  } catch (err: unknown) {
    if ((err as { code?: string }).code === "23505") {
      return c.json({ error: "tx already used" }, 409);
    }
    throw err;
  }

  // 4. Apply the undo to the active game state.
  const cas = await casPop(fid);
  if (!cas.ok) {
    await sql`DELETE FROM undo_payments WHERE tx_hash = ${txHash}`;
    return c.json({
      error: cas.reason === "empty" ? "nothing to undo" : cas.reason,
      state: cas.game ? projectState(cas.game) : null,
    }, 409);
  }

  // 5. Burn the intent so the same nonce can't be replayed.
  await redis.del(intentKey(nonce));

  return c.json({ state: projectState(cas.game) });
});

const submitSchema = z
  .object({
    username: z.string().min(1).max(40).optional(),
    pfp_url: z.string().url().max(500).optional(),
  })
  .partial();

app.post("/api/scores/submit", farcasterAuth, async (c) => {
  const fid = c.get("fid");

  const allowed = await rateLimit(
    `ratelimit:submit:${fid}`,
    SCORE_SUBMIT_LIMIT,
    SCORE_SUBMIT_WINDOW
  );
  if (!allowed) return c.json({ error: "too many requests" }, 429);

  const body = await c.req.json().catch(() => ({}));
  const parsed = submitSchema.safeParse(body ?? {});
  if (!parsed.success) {
    return c.json({ error: "invalid payload" }, 400);
  }
  const { username, pfp_url } = parsed.data;

  const game = await getGame(fid);
  if (!game) return c.json({ error: "no active game" }, 404);

  const r = replay(game.seed, game.move_log);
  if (!r.over) return c.json({ error: "game not over" }, 400);
  if (r.score === 0) return c.json({ error: "no progress" }, 400);

  await markFinished(fid);

  const [updated] = await sql`
    INSERT INTO scores (fid, username, pfp_url, score, max_tile, moves)
    VALUES (${fid}, ${username ?? null}, ${pfp_url ?? null}, ${r.score}, ${r.max_tile}, ${r.moves})
    ON CONFLICT (fid) DO UPDATE
      SET score = EXCLUDED.score,
          max_tile = EXCLUDED.max_tile,
          moves = EXCLUDED.moves,
          username = EXCLUDED.username,
          pfp_url = EXCLUDED.pfp_url,
          updated_at = now()
      WHERE EXCLUDED.score > scores.score
    RETURNING fid, username, pfp_url, score, max_tile, moves, updated_at
  `;
  if (!updated) {
    const [existing] = await sql`
      SELECT fid, username, pfp_url, score, max_tile, moves, updated_at
      FROM scores WHERE fid = ${fid}
    `;
    return c.json({ score: existing, updated: false });
  }
  await cacheInvalidatePattern("scores:top:*");
  return c.json({ score: updated, updated: true }, 201);
});

const port = Number(process.env.PORT ?? 8080);
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`api listening on http://localhost:${info.port}`);
});
