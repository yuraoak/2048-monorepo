import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { canMove, hasWon, maxTile, move, newGame, type Board, type Direction } from "./game";
import { apiConfigured, fetchScores, postScore, saveGame, type ScoreRow } from "./api";

const BEST_KEY = "2048.best";
const PLAYER_KEY = "2048.player";
const GAME_KEY = "2048.gameId";

function newGameId() {
  return crypto.randomUUID();
}

export function App() {
  const [board, setBoard] = useState<Board>(() => newGame());
  const [score, setScore] = useState(0);
  const [moves, setMoves] = useState(0);
  const [best, setBest] = useState(() => Number(localStorage.getItem(BEST_KEY) ?? 0));
  const [player, setPlayer] = useState(() => localStorage.getItem(PLAYER_KEY) ?? "");
  const [gameId, setGameId] = useState(() => localStorage.getItem(GAME_KEY) ?? newGameId());
  const [status, setStatus] = useState<"playing" | "won" | "lost">("playing");
  const [submitted, setSubmitted] = useState(false);
  const [scores, setScores] = useState<ScoreRow[]>([]);
  const [scoresError, setScoresError] = useState<string | null>(null);

  useEffect(() => { localStorage.setItem(GAME_KEY, gameId); }, [gameId]);
  useEffect(() => { localStorage.setItem(PLAYER_KEY, player); }, [player]);
  useEffect(() => {
    if (score > best) {
      setBest(score);
      localStorage.setItem(BEST_KEY, String(score));
    }
  }, [score, best]);

  const refreshScores = useCallback(async () => {
    if (!apiConfigured) return;
    try {
      setScores(await fetchScores(10));
      setScoresError(null);
    } catch (err) {
      setScoresError(String(err));
    }
  }, []);

  useEffect(() => { refreshScores(); }, [refreshScores]);

  const persistRef = useRef<number | null>(null);
  useEffect(() => {
    if (!apiConfigured || !player.trim()) return;
    if (persistRef.current) window.clearTimeout(persistRef.current);
    persistRef.current = window.setTimeout(() => {
      saveGame({
        id: gameId,
        player: player.trim(),
        board,
        score,
        moves,
        finished: status !== "playing",
      }).catch(() => {});
    }, 600);
  }, [board, score, moves, player, gameId, status]);

  const reset = useCallback(() => {
    setBoard(newGame());
    setScore(0);
    setMoves(0);
    setStatus("playing");
    setSubmitted(false);
    setGameId(newGameId());
  }, []);

  const apply = useCallback((dir: Direction) => {
    if (status === "lost") return;
    const { board: next, gained, moved } = move(board, dir);
    if (!moved) return;

    const empty: Array<[number, number]> = [];
    for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) if (next[r][c] === 0) empty.push([r, c]);
    let withSpawn: Board;
    if (empty.length === 0) {
      withSpawn = next;
    } else {
      const [rr, cc] = empty[Math.floor(Math.random() * empty.length)];
      withSpawn = next.map((row) => row.slice());
      withSpawn[rr][cc] = Math.random() < 0.9 ? 2 : 4;
    }

    setBoard(withSpawn);
    setScore((s) => s + gained);
    setMoves((m) => m + 1);

    if (hasWon(withSpawn) && status === "playing") setStatus("won");
    else if (!canMove(withSpawn)) setStatus("lost");
  }, [board, status]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const map: Record<string, Direction> = {
        ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right",
        w: "up", s: "down", a: "left", d: "right",
        W: "up", S: "down", A: "left", D: "right",
      };
      const dir = map[e.key];
      if (!dir) return;
      e.preventDefault();
      apply(dir);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [apply]);

  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const onTouchStart = (e: React.TouchEvent) => {
    const t = e.touches[0];
    touchStart.current = { x: t.clientX, y: t.clientY };
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    if (!touchStart.current) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - touchStart.current.x;
    const dy = t.clientY - touchStart.current.y;
    touchStart.current = null;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < 24) return;
    if (Math.abs(dx) > Math.abs(dy)) apply(dx > 0 ? "right" : "left");
    else apply(dy > 0 ? "down" : "up");
  };

  const submit = useCallback(async () => {
    if (!apiConfigured || submitted || !player.trim() || score === 0) return;
    try {
      await postScore({ player: player.trim(), score, max_tile: maxTile(board), moves });
      setSubmitted(true);
      await refreshScores();
    } catch (err) {
      setScoresError(String(err));
    }
  }, [player, score, board, moves, submitted, refreshScores]);

  useEffect(() => {
    if (status !== "playing" && !submitted) submit();
  }, [status, submitted, submit]);

  const flat = useMemo(() => board.flat(), [board]);

  return (
    <div className="app">
      <header className="header">
        <h1>2048</h1>
        <div className="scores">
          <div className="score-box">
            <div className="label">Score</div>
            <div className="value">{score}</div>
          </div>
          <div className="score-box">
            <div className="label">Best</div>
            <div className="value">{best}</div>
          </div>
        </div>
      </header>

      <div className="toolbar">
        <input
          type="text"
          placeholder="Имя для лидерборда"
          value={player}
          onChange={(e) => setPlayer(e.target.value.slice(0, 40))}
          maxLength={40}
        />
        <button className="btn" onClick={reset}>Новая игра</button>
        {apiConfigured && (
          <button
            className="btn ghost"
            onClick={submit}
            disabled={!player.trim() || submitted || score === 0}
          >
            {submitted ? "Сохранено" : "Сохранить счёт"}
          </button>
        )}
      </div>

      <div className="hint">Стрелки или WASD. На телефоне — свайпы.</div>

      <div className="board" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
        {flat.map((v, i) => (
          <div className="cell" key={i} data-v={v}>{v === 0 ? "" : v}</div>
        ))}
      </div>

      <div className={`status ${status === "won" ? "win" : status === "lost" ? "lose" : ""}`}>
        {status === "won" && "Победа! 2048 собрано."}
        {status === "lost" && "Ходов больше нет."}
        {status === "playing" && `Ходов: ${moves} · Макс. плитка: ${maxTile(board)}`}
      </div>

      {apiConfigured ? (
        <section className="leaderboard">
          <h2>Топ-10</h2>
          {scoresError && <div className="muted">Ошибка: {scoresError}</div>}
          {scores.length === 0 && !scoresError && <div className="muted">Пока пусто — стань первым.</div>}
          {scores.length > 0 && (
            <table>
              <thead>
                <tr>
                  <th className="rank">#</th>
                  <th>Игрок</th>
                  <th className="num">Score</th>
                  <th className="num">Tile</th>
                  <th className="num">Ходы</th>
                </tr>
              </thead>
              <tbody>
                {scores.map((s, i) => (
                  <tr key={s.id}>
                    <td className="rank">{i + 1}</td>
                    <td>{s.player}</td>
                    <td className="num">{s.score}</td>
                    <td className="num">{s.max_tile}</td>
                    <td className="num">{s.moves}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      ) : (
        <div className="muted">VITE_API_URL не задан — лидерборд отключён.</div>
      )}
    </div>
  );
}
