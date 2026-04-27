const API_URL = (import.meta.env.VITE_API_URL ?? "").replace(/\/$/, "");

export type ScoreRow = {
  id: number;
  player: string;
  score: number;
  max_tile: number;
  moves: number;
  created_at: string;
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

export async function fetchScores(limit = 10): Promise<ScoreRow[]> {
  const data = await request<{ scores: ScoreRow[] }>(`/api/scores?limit=${limit}`);
  return data.scores;
}

export async function postScore(payload: {
  player: string;
  score: number;
  max_tile: number;
  moves: number;
}): Promise<ScoreRow> {
  const data = await request<{ score: ScoreRow }>(`/api/scores`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
  return data.score;
}

export async function saveGame(payload: {
  id: string;
  player: string;
  board: number[][];
  score: number;
  moves: number;
  finished: boolean;
}): Promise<void> {
  await request(`/api/games/${payload.id}`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

export const apiConfigured = API_URL.length > 0;
