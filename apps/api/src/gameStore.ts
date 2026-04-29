import { redis } from "./cache.js";

// Active game lives in Redis for the hot path: every keypress reads/writes
// the current state. Postgres keeps only durable records (scores, undo
// payments). Active games are ephemeral — losing them on Redis crash means
// players just start over, which is acceptable.

const TTL_SEC = 60 * 60 * 24 * 7; // 7 days
const key = (fid: number) => `game:active:${fid}`;

export type ActiveGame = {
  seed: number;
  move_log: string;
  finished: boolean;
};

function requireRedis() {
  if (!redis) throw new Error("REDIS_URL is required for game state");
  return redis;
}

export async function getGame(fid: number): Promise<ActiveGame | null> {
  const r = requireRedis();
  const raw = await r.get(key(fid));
  if (!raw) return null;
  return JSON.parse(raw) as ActiveGame;
}

export async function setGame(fid: number, game: ActiveGame): Promise<void> {
  const r = requireRedis();
  await r.set(key(fid), JSON.stringify(game), "EX", TTL_SEC);
}

export async function deleteGame(fid: number): Promise<void> {
  const r = requireRedis();
  await r.del(key(fid));
}

export type CasResult =
  | { ok: true; game: ActiveGame }
  | { ok: false; reason: "missing" | "finished" | "len_mismatch" | "empty"; game: ActiveGame | null };

// Atomic compare-and-set append: only commits if the stored move_log still
// has length == expectedLen and the game isn't finished.
const APPEND_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return {1} end
local game = cjson.decode(raw)
if game.finished then return {2, raw} end
if string.len(game.move_log) ~= tonumber(ARGV[1]) then return {3, raw} end
game.move_log = ARGV[2]
local encoded = cjson.encode(game)
redis.call('SET', KEYS[1], encoded, 'EX', ARGV[3])
return {0, encoded}
`;

export async function casAppend(
  fid: number,
  expectedLen: number,
  newMoveLog: string
): Promise<CasResult> {
  const r = requireRedis();
  const result = (await r.eval(
    APPEND_SCRIPT,
    1,
    key(fid),
    String(expectedLen),
    newMoveLog,
    String(TTL_SEC)
  )) as [number, string?];
  const [code, payload] = result;
  if (code === 0) return { ok: true, game: JSON.parse(payload!) as ActiveGame };
  if (code === 1) return { ok: false, reason: "missing", game: null };
  const game = payload ? (JSON.parse(payload) as ActiveGame) : null;
  if (code === 2) return { ok: false, reason: "finished", game };
  return { ok: false, reason: "len_mismatch", game };
}

// Atomic pop of the last move character.
const POP_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return {1} end
local game = cjson.decode(raw)
if game.finished then return {2, raw} end
if string.len(game.move_log) == 0 then return {4, raw} end
game.move_log = string.sub(game.move_log, 1, -2)
local encoded = cjson.encode(game)
redis.call('SET', KEYS[1], encoded, 'EX', ARGV[1])
return {0, encoded}
`;

export async function casPop(fid: number): Promise<CasResult> {
  const r = requireRedis();
  const result = (await r.eval(POP_SCRIPT, 1, key(fid), String(TTL_SEC))) as [number, string?];
  const [code, payload] = result;
  if (code === 0) return { ok: true, game: JSON.parse(payload!) as ActiveGame };
  if (code === 1) return { ok: false, reason: "missing", game: null };
  const game = payload ? (JSON.parse(payload) as ActiveGame) : null;
  if (code === 2) return { ok: false, reason: "finished", game };
  return { ok: false, reason: "empty", game };
}

// Atomic mark-finished: used right after writing the score row so resume
// returns the over board with finished=true.
const FINISH_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local game = cjson.decode(raw)
game.finished = true
redis.call('SET', KEYS[1], cjson.encode(game), 'EX', ARGV[1])
return 1
`;

export async function markFinished(fid: number): Promise<void> {
  const r = requireRedis();
  await r.eval(FINISH_SCRIPT, 1, key(fid), String(TTL_SEC));
}
