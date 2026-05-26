import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { z } from "zod";
import { sql } from "./db.js";
import { farcasterAuth } from "./auth.js";
import { cacheGet, cacheSet, cacheInvalidatePattern, rateLimit, redis } from "./cache.js";
import { replay } from "./replay.js";
import { treasuryAddress, verifyTreasuryPayment } from "./onchain.js";
import { isPackId, UNDO_PACKS, type PackId } from "./shop.js";
import {
  casAppend,
  casPop,
  getGame,
  markFinished,
  setGame,
  type ActiveGame,
} from "./gameStore.js";
import { renderShareImage } from "./shareImage.js";
import { getPublicObject, isStorageConfigured, uploadPublicObject } from "./storage.js";
import { randomBytes } from "node:crypto";

const SCORES_CACHE_TTL = 15;
const SCORE_SUBMIT_LIMIT = 5;
const SCORE_SUBMIT_WINDOW = 60;
const MOVE_LIMIT = 240;
const MOVE_WINDOW = 60;
const UNDO_LIMIT = 10;
const UNDO_WINDOW = 60;
const SHARE_LIMIT = 10;
const SHARE_WINDOW = 60;

// Public origin where THIS api service is reachable. The share page is served
// from the api (so it can return dynamic fc:miniapp meta) — that URL is what
// gets pasted into the cast. Required when share is configured.
const apiPublicUrl = (process.env.API_PUBLIC_URL ?? "").replace(/\/$/, "");
// Public origin of the web app — used as the launch_miniapp target inside the
// share page meta tags so tapping the cast preview opens the game.
const webPublicUrl = (process.env.WEB_PUBLIC_URL ?? "").replace(/\/$/, "");

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
    chain_id: 8453,
    packs: Object.values(UNDO_PACKS).map((p) => ({
      id: p.id,
      undos: p.undos,
      price_wei: p.priceWei.toString(),
    })),
  })
);

// Undo credit balance lives on a separate table — paid balance, durability
// matters more than read latency. Helpers below stay close to the endpoints
// that use them.
async function getUndoCredits(fid: number): Promise<number> {
  const [row] = await sql<Array<{ balance: number }>>`
    SELECT balance FROM undo_credits WHERE fid = ${fid}
  `;
  return row?.balance ?? 0;
}

async function consumeUndoCredit(fid: number): Promise<boolean> {
  const [row] = await sql<Array<{ balance: number }>>`
    UPDATE undo_credits SET balance = balance - 1, updated_at = now()
    WHERE fid = ${fid} AND balance > 0
    RETURNING balance
  `;
  return Boolean(row);
}

async function addUndoCredits(fid: number, n: number): Promise<number> {
  const [row] = await sql<Array<{ balance: number }>>`
    INSERT INTO undo_credits (fid, balance) VALUES (${fid}, ${n})
    ON CONFLICT (fid) DO UPDATE
      SET balance = undo_credits.balance + EXCLUDED.balance, updated_at = now()
    RETURNING balance
  `;
  return row.balance;
}

app.get("/api/me", farcasterAuth, async (c) => {
  const fid = c.get("fid");
  const credits = await getUndoCredits(fid);
  return c.json({ fid, undo_credits: credits });
});

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

// Pack purchase: intent → on-chain payment → server credits the fid's
// balance. fid binding goes through `tx.value` (BASE_PRICE + nonce) instead
// of calldata because Farcaster's embedded wallet drops `data` on simple
// ETH transfers. Each pack has its own base price, so the server needs the
// pack id at /buy time to extract the nonce correctly.

const INTENT_TTL_SEC = 600;
const intentKey = (nonce: number) => `pack:intent:${nonce}`;
const INTENT_COUNTER_KEY = "pack:intent:counter";

const intentBodySchema = z.object({
  pack: z.enum(["small", "medium", "large"]),
});

app.post("/api/shop/packs/intent", farcasterAuth, async (c) => {
  const fid = c.get("fid");
  if (!redis) return c.json({ error: "redis unavailable" }, 503);

  const allowed = await rateLimit(`ratelimit:intent:${fid}`, UNDO_LIMIT, UNDO_WINDOW);
  if (!allowed) return c.json({ error: "too many requests" }, 429);

  const body = await c.req.json().catch(() => null);
  const parsed = intentBodySchema.safeParse(body);
  if (!parsed.success) return c.json({ error: "invalid payload" }, 400);

  const pack = UNDO_PACKS[parsed.data.pack];
  const nonce = await redis.incr(INTENT_COUNTER_KEY);
  await redis.set(
    intentKey(nonce),
    JSON.stringify({ fid, pack: pack.id }),
    "EX",
    INTENT_TTL_SEC
  );
  // Mirror the intent into Postgres so the Go reconciler can resolve
  // (nonce → fid, pack) for orphan payments long after Redis TTL expires.
  // Failure here must NOT block the user — Redis is still the source of
  // truth for the hot /buy path; the durable copy is best-effort.
  try {
    await sql`
      INSERT INTO pack_intents (nonce, fid, pack_id)
      VALUES (${nonce}, ${fid}, ${pack.id})
      ON CONFLICT (nonce) DO NOTHING
    `;
  } catch (err) {
    console.error("pack_intents insert failed", err);
  }

  const amountWei = pack.priceWei + BigInt(nonce);
  return c.json({
    nonce,
    pack: pack.id,
    undos: pack.undos,
    amount_wei: amountWei.toString(),
    treasury: treasuryAddress,
    expires_in_sec: INTENT_TTL_SEC,
  });
});

const buyBodySchema = z.object({
  txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  pack: z.enum(["small", "medium", "large"]),
});

app.post("/api/shop/packs/buy", farcasterAuth, async (c) => {
  const fid = c.get("fid");
  if (!redis) return c.json({ error: "redis unavailable" }, 503);

  const allowed = await rateLimit(`ratelimit:buy:${fid}`, UNDO_LIMIT, UNDO_WINDOW);
  if (!allowed) return c.json({ error: "too many requests" }, 429);

  const body = await c.req.json().catch(() => null);
  const parsed = buyBodySchema.safeParse(body);
  if (!parsed.success) return c.json({ error: "invalid payload" }, 400);
  const { pack: packId } = parsed.data;
  const txHash = parsed.data.txHash.toLowerCase();
  const pack = UNDO_PACKS[packId];

  // 1. Verify on-chain payment to treasury at this pack's price.
  let payment;
  try {
    payment = await verifyTreasuryPayment(txHash, pack.priceWei);
  } catch (err) {
    return c.json({ error: "payment verification failed", detail: String(err) }, 400);
  }

  // 2. Extract the nonce embedded in `value - pack.priceWei` and verify the
  // intent belongs to this fid AND matches the requested pack.
  const diff = payment.amountWei - pack.priceWei;
  if (diff < 0n || diff > BigInt(Number.MAX_SAFE_INTEGER)) {
    return c.json({ error: "amount out of range" }, 400);
  }
  const nonce = Number(diff);
  const intentRaw = await redis.get(intentKey(nonce));
  if (!intentRaw) return c.json({ error: "intent expired or unknown" }, 400);
  const intent = JSON.parse(intentRaw) as { fid: number; pack: PackId };
  if (intent.fid !== fid) return c.json({ error: "intent mismatch" }, 400);
  if (!isPackId(intent.pack) || intent.pack !== packId) {
    return c.json({ error: "intent mismatch" }, 400);
  }

  // 3. Claim tx_hash in Postgres (PK enforces one-time use). If the credit
  // step fails, roll back so the tx can be retried.
  try {
    await sql`
      INSERT INTO undo_payments (
        tx_hash, fid, pack_id, undos_credited, amount_wei, block_number
      )
      VALUES (
        ${txHash}, ${fid}, ${pack.id}, ${pack.undos},
        ${payment.amountWei.toString()}, ${payment.blockNumber}
      )
    `;
  } catch (err: unknown) {
    if ((err as { code?: string }).code === "23505") {
      return c.json({ error: "tx already used" }, 409);
    }
    throw err;
  }

  // 4. Credit the user's undo balance.
  let balance: number;
  try {
    balance = await addUndoCredits(fid, pack.undos);
  } catch (err) {
    await sql`DELETE FROM undo_payments WHERE tx_hash = ${txHash}`;
    throw err;
  }

  // 5. Burn the intent so the nonce can't be replayed.
  await redis.del(intentKey(nonce));

  return c.json({ undo_credits: balance, undos_credited: pack.undos });
});

app.post("/api/games/undo", farcasterAuth, async (c) => {
  const fid = c.get("fid");

  const allowed = await rateLimit(`ratelimit:undo:${fid}`, UNDO_LIMIT, UNDO_WINDOW);
  if (!allowed) return c.json({ error: "too many requests" }, 429);

  // Spend a credit first; if the actual pop fails, refund. This avoids the
  // window where the user holds credits but the pop hits a transient error
  // that double-charges them.
  const spent = await consumeUndoCredit(fid);
  if (!spent) return c.json({ error: "no undo credits", undo_credits: 0 }, 402);

  const cas = await casPop(fid);
  if (!cas.ok) {
    const balance = await addUndoCredits(fid, 1);
    return c.json({
      error: cas.reason === "empty" ? "nothing to undo" : cas.reason,
      state: cas.game ? projectState(cas.game) : null,
      undo_credits: balance,
    }, 409);
  }

  const balance = await getUndoCredits(fid);
  return c.json({ state: projectState(cas.game), undo_credits: balance });
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

  // The leaderboard tracks personal best (`score`/`max_tile`/`moves`); we
  // only overwrite those when the player improves. But the share image must
  // always reflect THIS game, so we unconditionally write `final_*` and the
  // (seed, move_log) replay tuple — those columns track "last finished
  // game", not "best".
  const [existing] = await sql<Array<{ score: number }>>`
    SELECT score FROM scores WHERE fid = ${fid}
  `;
  const newBest = !existing || r.score > existing.score;

  const [updated] = await sql<
    Array<{
      fid: number;
      username: string | null;
      pfp_url: string | null;
      score: number;
      max_tile: number;
      moves: number;
      updated_at: Date;
    }>
  >`
    INSERT INTO scores (
      fid, username, pfp_url, score, max_tile, moves,
      final_board, final_score, final_max_tile, seed, move_log
    )
    VALUES (
      ${fid}, ${username ?? null}, ${pfp_url ?? null},
      ${r.score}, ${r.max_tile}, ${r.moves},
      ${sql.json(r.board)}, ${r.score}, ${r.max_tile}, ${game.seed}, ${game.move_log}
    )
    ON CONFLICT (fid) DO UPDATE
      SET final_board = EXCLUDED.final_board,
          final_score = EXCLUDED.final_score,
          final_max_tile = EXCLUDED.final_max_tile,
          seed = EXCLUDED.seed,
          move_log = EXCLUDED.move_log,
          username = COALESCE(EXCLUDED.username, scores.username),
          pfp_url = COALESCE(EXCLUDED.pfp_url, scores.pfp_url),
          score = CASE WHEN EXCLUDED.score > scores.score THEN EXCLUDED.score ELSE scores.score END,
          max_tile = CASE WHEN EXCLUDED.score > scores.score THEN EXCLUDED.max_tile ELSE scores.max_tile END,
          moves = CASE WHEN EXCLUDED.score > scores.score THEN EXCLUDED.moves ELSE scores.moves END,
          updated_at = CASE WHEN EXCLUDED.score > scores.score THEN now() ELSE scores.updated_at END
    RETURNING fid, username, pfp_url, score, max_tile, moves, updated_at
  `;
  if (newBest) {
    await cacheInvalidatePattern("scores:top:*");
  }
  return c.json({
    score: updated,
    last_game: { score: r.score, max_tile: r.max_tile },
    new_best: newBest,
  }, 201);
});

// ---- Farcaster share ----
//
// Posting a 2048 result as a cast goes through these steps:
//   1. Game-over modal mounts → client calls POST /api/share/preview. Server
//      replays the snapshot stored in `scores`, computes rank, renders a
//      1200×800 PNG and returns it inline as a base64 data URL. Nothing is
//      persisted — if the user closes the modal we don't litter S3 with
//      images that nobody will ever see.
//   2. User clicks "Share to Farcaster" → client calls POST /api/share/create.
//      Server re-renders, uploads the PNG to S3-compatible storage,
//      saves a `shares` row keyed by a short opaque id, and returns the
//      public share URL.
//   3. Client calls sdk.actions.composeCast({ embeds: [share_url] }). The
//      Farcaster client scrapes the share page, sees the fc:miniapp meta,
//      and renders the rich card with our image and a "Play" button.

type ShareSnapshot = {
  board: number[][];
  score: number;
  maxTile: number;
  username: string | null;
  avatarUrl: string | null;
};

async function loadShareSnapshot(
  fid: number
): Promise<ShareSnapshot | { error: string; status: 409 }> {
  const [row] = await sql<
    Array<{
      fid: number;
      username: string | null;
      pfp_url: string | null;
      final_score: number | null;
      final_max_tile: number | null;
      final_board: number[][] | string | null;
    }>
  >`
    SELECT fid, username, pfp_url, final_score, final_max_tile, final_board
    FROM scores WHERE fid = ${fid}
  `;
  if (!row || row.final_board == null || row.final_score == null || row.final_max_tile == null) {
    return { error: "no finished game to share — finish a game first", status: 409 };
  }
  // Older rows (written before sql.json was used) stored the board as a
  // double-encoded JSONB string. Decode if we see one, so existing snapshots
  // remain shareable without forcing the user to play again.
  const board: number[][] =
    typeof row.final_board === "string" ? JSON.parse(row.final_board) : row.final_board;
  if (!Array.isArray(board)) {
    return { error: "corrupted snapshot — finish another game", status: 409 };
  }
  return {
    board,
    score: row.final_score,
    maxTile: row.final_max_tile,
    username: row.username,
    avatarUrl: row.pfp_url,
  };
}

async function rankForScore(score: number): Promise<number> {
  // Where the just-finished game would land if it were the player's PB.
  // Counts strictly-better PBs in the leaderboard; +1 places this score
  // immediately after them.
  const [{ count }] = await sql<Array<{ count: string }>>`
    SELECT COUNT(*)::text AS count FROM scores WHERE score > ${score}
  `;
  return Number(count) + 1;
}

function newShareId(): string {
  // 12 bytes of url-safe randomness — collision probability is negligible
  // and the resulting string is short enough to fit comfortably in the
  // Farcaster 1024-char URL budget.
  return randomBytes(12).toString("base64url");
}

app.post("/api/share/preview", farcasterAuth, async (c) => {
  const fid = c.get("fid");

  const allowed = await rateLimit(`ratelimit:share:${fid}`, SHARE_LIMIT, SHARE_WINDOW);
  if (!allowed) return c.json({ error: "too many requests" }, 429);

  const snap = await loadShareSnapshot(fid);
  if ("error" in snap) return c.json({ error: snap.error }, snap.status);

  const rank = await rankForScore(snap.score);
  const png = await renderShareImage({
    board: snap.board,
    score: snap.score,
    rank,
    maxTile: snap.maxTile,
    username: snap.username,
    avatarUrl: snap.avatarUrl,
    fid,
  });

  return c.json({
    image_data_url: `data:image/png;base64,${png.toString("base64")}`,
    score: snap.score,
    rank,
    max_tile: snap.maxTile,
  });
});

app.post("/api/share/create", farcasterAuth, async (c) => {
  const fid = c.get("fid");

  if (!isStorageConfigured()) {
    return c.json({ error: "share storage not configured" }, 503);
  }
  if (!apiPublicUrl) {
    return c.json({ error: "API_PUBLIC_URL not configured" }, 503);
  }

  const allowed = await rateLimit(`ratelimit:share:${fid}`, SHARE_LIMIT, SHARE_WINDOW);
  if (!allowed) return c.json({ error: "too many requests" }, 429);

  const snap = await loadShareSnapshot(fid);
  if ("error" in snap) return c.json({ error: snap.error }, snap.status);

  const rank = await rankForScore(snap.score);
  const png = await renderShareImage({
    board: snap.board,
    score: snap.score,
    rank,
    maxTile: snap.maxTile,
    username: snap.username,
    avatarUrl: snap.avatarUrl,
    fid,
  });

  const id = newShareId();
  const objectKey = `shares/${id}.png`;
  await uploadPublicObject(objectKey, png, "image/png");

  // Some S3-compatible backends (e.g. Tigris) return 501 on
  // PutBucketPolicy and expose no public-read toggle, so direct bucket
  // URLs are 403 to anonymous clients. We hand out an api-hosted URL and
  // stream the PNG through /share-image/:id with credentials.
  const imageUrl = `${apiPublicUrl}/share-image/${id}`;

  await sql`
    INSERT INTO shares (id, fid, score, rank, max_tile, image_url)
    VALUES (${id}, ${fid}, ${snap.score}, ${rank}, ${snap.maxTile}, ${imageUrl})
  `;

  const shareUrl = `${apiPublicUrl}/share/${id}`;
  return c.json({
    id,
    share_url: shareUrl,
    image_url: imageUrl,
    score: snap.score,
    rank,
    max_tile: snap.maxTile,
  });
});

app.get("/share-image/:id", async (c) => {
  if (!isStorageConfigured()) return c.text("storage not configured", 503);
  const id = c.req.param("id");
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return c.notFound();
  const obj = await getPublicObject(`shares/${id}.png`);
  if (!obj) return c.notFound();
  return new Response(obj.body as BodyInit, {
    headers: {
      "Content-Type": obj.contentType,
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
});

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Public share landing page. Farcaster scrapes this when the share URL is
// pasted into a cast and renders the rich preview from fc:miniapp meta.
// We still serve fc:frame for backward compat with older clients.
app.get("/share/:id", async (c) => {
  const id = c.req.param("id");
  const [row] = await sql<
    Array<{
      id: string;
      score: number;
      rank: number | null;
      max_tile: number;
      image_url: string;
    }>
  >`SELECT id, score, rank, max_tile, image_url FROM shares WHERE id = ${id}`;

  if (!row) {
    return c.html("<!doctype html><title>Not found</title><p>Share not found.</p>", 404);
  }

  const launchUrl = webPublicUrl || apiPublicUrl;
  const title = `2048 · ${row.score} pts${row.rank ? ` · #${row.rank}` : ""}`;
  const embed = {
    version: "1",
    imageUrl: row.image_url,
    button: {
      title: "Play 2048",
      action: {
        type: "launch_miniapp",
        name: "2048",
        url: launchUrl,
      },
    },
  };
  // fc:frame accepts the same shape but with launch_frame. Keeps legacy
  // clients happy until they migrate to fc:miniapp.
  const frameEmbed = {
    ...embed,
    button: {
      ...embed.button,
      action: { ...embed.button.action, type: "launch_frame" },
    },
  };

  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(title)}</title>
    <meta property="og:title" content="${escapeHtml(title)}" />
    <meta property="og:image" content="${escapeHtml(row.image_url)}" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:image" content="${escapeHtml(row.image_url)}" />
    <meta name="fc:miniapp" content='${escapeHtml(JSON.stringify(embed))}' />
    <meta name="fc:frame" content='${escapeHtml(JSON.stringify(frameEmbed))}' />
  </head>
  <body style="margin:0;background:#faf8ef;color:#776e65;font-family:-apple-system,BlinkMacSystemFont,sans-serif;">
    <div style="max-width:720px;margin:0 auto;padding:24px;text-align:center;">
      <img src="${escapeHtml(row.image_url)}" alt="2048 score card" style="width:100%;height:auto;border-radius:12px;" />
      <p style="margin-top:24px;">
        <a href="${escapeHtml(launchUrl)}" style="display:inline-block;padding:12px 24px;background:#8f7a66;color:#fff;text-decoration:none;border-radius:8px;font-weight:600;">Play 2048</a>
      </p>
    </div>
  </body>
</html>`;
  c.header("Cache-Control", "public, max-age=300");
  return c.html(html);
});

const port = Number(process.env.PORT ?? 8080);
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`api listening on http://localhost:${info.port}`);
});
