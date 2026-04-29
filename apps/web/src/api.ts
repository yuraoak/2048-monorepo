const API_URL = (import.meta.env.VITE_API_URL ?? "").replace(/\/$/, "");

export type ScoreRow = {
  fid: number;
  username: string | null;
  pfp_url: string | null;
  score: number;
  max_tile: number;
  moves: number;
  updated_at: string;
};

export type GameState = {
  seed: number;
  board: number[][];
  score: number;
  max_tile: number;
  moves: number;
  move_log: string;
  log_len: number;
  over: boolean;
  finished: boolean;
};

// Lite variant returned by /api/games/move — omits the full move log to
// shrink hot-path payloads. Client only needs log_len for sync detection.
export type GameStateLite = Omit<GameState, "move_log">;

export type Config = {
  treasury: string;
  undo_price_wei: string;
  chain_id: number;
};

type FetchFn = typeof fetch;

async function request<T>(path: string, init: RequestInit, fetcher: FetchFn): Promise<T> {
  const res = await fetcher(`${API_URL}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText}${text ? ` — ${text}` : ""}`);
  }
  return (await res.json()) as T;
}

export async function fetchScores(limit = 20, offset = 0): Promise<ScoreRow[]> {
  const data = await request<{ scores: ScoreRow[] }>(
    `/api/scores?limit=${limit}&offset=${offset}`,
    {},
    fetch
  );
  return data.scores;
}

export async function fetchMyScore(fetcher: FetchFn): Promise<ScoreRow | null> {
  const res = await fetcher(`${API_URL}/api/scores/me`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const data = (await res.json()) as { score: ScoreRow };
  return data.score;
}

export async function fetchConfig(): Promise<Config> {
  return await request<Config>(`/api/config`, {}, fetch);
}

export async function fetchGameState(fetcher: FetchFn): Promise<GameState | null> {
  const data = await request<{ state: GameState | null }>(
    `/api/games/state`,
    { method: "POST" },
    fetcher
  );
  return data.state;
}

export async function startGame(fetcher: FetchFn): Promise<GameState> {
  const data = await request<{ state: GameState }>(
    `/api/games/start`,
    { method: "POST" },
    fetcher
  );
  return data.state;
}

export type MoveResult =
  | { ok: true; state: GameStateLite }
  | { ok: false; status: number; error: string; state: GameStateLite | null };

export async function postMove(
  dirs: string,
  expectedLen: number,
  fetcher: FetchFn
): Promise<MoveResult> {
  const res = await fetcher(`${API_URL}/api/games/move`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ dirs, expectedLen }),
  });
  const data = (await res.json().catch(() => ({}))) as {
    state?: GameStateLite;
    error?: string;
  };
  if (res.ok && data.state) return { ok: true, state: data.state };
  return { ok: false, status: res.status, error: data.error ?? `${res.status}`, state: data.state ?? null };
}

export type UndoIntent = {
  nonce: number;
  amount_wei: string;
  treasury: string;
  expires_in_sec: number;
};

export async function fetchUndoIntent(fetcher: FetchFn): Promise<UndoIntent> {
  return await request<UndoIntent>(
    `/api/games/undo/intent`,
    { method: "POST" },
    fetcher
  );
}

export async function postUndo(txHash: string, fetcher: FetchFn): Promise<GameState> {
  const data = await request<{ state: GameState }>(
    `/api/games/undo`,
    { method: "POST", body: JSON.stringify({ txHash }) },
    fetcher
  );
  return data.state;
}

export async function submitScore(
  payload: { username?: string; pfp_url?: string },
  fetcher: FetchFn
): Promise<ScoreRow> {
  const data = await request<{ score: ScoreRow }>(
    `/api/scores/submit`,
    { method: "POST", body: JSON.stringify(payload) },
    fetcher
  );
  return data.score;
}
