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

export type Pack = {
  id: "small" | "medium" | "large";
  undos: number;
  price_wei: string;
};

export type Config = {
  treasury: string;
  chain_id: number;
  packs: Pack[];
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

export type Me = { fid: number; undo_credits: number };

export async function fetchMe(fetcher: FetchFn): Promise<Me> {
  return await request<Me>(`/api/me`, {}, fetcher);
}

export type PackIntent = {
  nonce: number;
  pack: Pack["id"];
  undos: number;
  amount_wei: string;
  treasury: string;
  expires_in_sec: number;
};

export async function fetchPackIntent(
  pack: Pack["id"],
  fetcher: FetchFn
): Promise<PackIntent> {
  return await request<PackIntent>(
    `/api/shop/packs/intent`,
    { method: "POST", body: JSON.stringify({ pack }) },
    fetcher
  );
}

export type BuyPackResult = { undo_credits: number; undos_credited: number };

export async function buyPack(
  txHash: string,
  pack: Pack["id"],
  fetcher: FetchFn
): Promise<BuyPackResult> {
  return await request<BuyPackResult>(
    `/api/shop/packs/buy`,
    { method: "POST", body: JSON.stringify({ txHash, pack }) },
    fetcher
  );
}

export type UndoResult =
  | { ok: true; state: GameState; undo_credits: number }
  | { ok: false; status: number; error: string; undo_credits?: number };

export async function postUndo(fetcher: FetchFn): Promise<UndoResult> {
  const res = await fetcher(`${API_URL}/api/games/undo`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  const data = (await res.json().catch(() => ({}))) as {
    state?: GameState;
    error?: string;
    undo_credits?: number;
  };
  if (res.ok && data.state) {
    return { ok: true, state: data.state, undo_credits: data.undo_credits ?? 0 };
  }
  return {
    ok: false,
    status: res.status,
    error: data.error ?? `${res.status}`,
    undo_credits: data.undo_credits,
  };
}

export type SubmitScoreResult = {
  score: ScoreRow;
  last_game: { score: number; max_tile: number };
  new_best: boolean;
};

export async function submitScore(
  payload: { username?: string; pfp_url?: string },
  fetcher: FetchFn
): Promise<SubmitScoreResult> {
  return await request<SubmitScoreResult>(
    `/api/scores/submit`,
    { method: "POST", body: JSON.stringify(payload) },
    fetcher
  );
}

export type SharePreviewResult = {
  // Inline base64 PNG. Avoids the S3 upload until the user actually decides
  // to share, but means the response is ~150 KB (the full image bytes).
  image_data_url: string;
  score: number;
  rank: number;
  max_tile: number;
};

export async function previewShare(fetcher: FetchFn): Promise<SharePreviewResult> {
  return await request<SharePreviewResult>(
    `/api/share/preview`,
    { method: "POST" },
    fetcher
  );
}

export type ShareResult = {
  id: string;
  share_url: string;
  image_url: string;
  score: number;
  rank: number;
  max_tile: number;
};

export async function createShare(fetcher: FetchFn): Promise<ShareResult> {
  return await request<ShareResult>(
    `/api/share/create`,
    { method: "POST" },
    fetcher
  );
}
