import { type CSSProperties, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import sdk from "@farcaster/miniapp-sdk";
import {
  canMove,
  maxTileValue,
  move,
  mulberry32,
  newGameTiles,
  spawnTile,
  type Direction,
  type Rng,
  type Tile,
} from "./game";
import {
  fetchGameState,
  fetchMyScore,
  fetchScores,
  fetchUndoIntent,
  postMove,
  postUndo,
  startGame,
  submitScore,
  type GameState,
  type ScoreRow,
} from "./api";
import { payForUndo } from "./wallet";

const PAGE_SIZE = 20;

const DIR_TO_CHAR: Record<Direction, "u" | "d" | "l" | "r"> = {
  up: "u",
  down: "d",
  left: "l",
  right: "r",
};
const DIR_FROM_CHAR: Record<string, Direction> = {
  u: "up",
  d: "down",
  l: "left",
  r: "right",
};

type FarcasterUser = { fid: number; username?: string; pfpUrl?: string };
type AuthState = { user: FarcasterUser; fetcher: typeof fetch };
type Mode = "loading" | "ready" | "outside";

export function App() {
  const [mode, setMode] = useState<Mode>("loading");
  const [auth, setAuth] = useState<AuthState | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const inApp = await sdk.isInMiniApp();
        if (cancelled) return;
        if (!inApp) {
          setMode("outside");
          return;
        }
        // Swipes-down (and "tap outside") otherwise dismiss the Farcaster
        // sheet, which conflicts with the swipe-to-move gesture on the board.
        await sdk.actions.ready({ disableNativeGestures: true });
        const ctx = await sdk.context;
        if (cancelled) return;
        setAuth({
          user: { fid: ctx.user.fid, username: ctx.user.username, pfpUrl: ctx.user.pfpUrl },
          fetcher: sdk.quickAuth.fetch.bind(sdk.quickAuth),
        });
        setMode("ready");
      } catch {
        if (!cancelled) setMode("outside");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (mode === "loading") {
    return (
      <div className="app">
        <div className="hint">Loading…</div>
      </div>
    );
  }
  if (mode === "outside" || !auth) return <FallbackPage />;
  return <Game auth={auth} />;
}

type TileProps = {
  row: number;
  col: number;
  value: number;
  isNew?: boolean;
  merged?: boolean;
};

// Memoized so an unchanged tile (same row/col/value/flags) skips re-render
// when other tiles or score state changes. With 16 tiles on the board this
// removes the bulk of redundant DOM work during a move.
const TileView = memo(function TileView({ row, col, value, isNew, merged }: TileProps) {
  return (
    <div className="tile" style={{ "--row": row, "--col": col } as CSSProperties}>
      <div
        className={`tile-inner${isNew ? " is-new" : ""}${merged ? " is-merged" : ""}`}
        data-v={value}
      >
        {value}
      </div>
    </div>
  );
});

function FallbackPage() {
  const sample = [2, 4, 8, 16, 4, 8, 16, 32, 8, 16, 32, 64, 16, 32, 64, 128];
  return (
    <div className="app">
      <header className="header">
        <h1>2048</h1>
      </header>
      <p className="hint">This mini app only works inside Farcaster.</p>
      <div className="board" aria-hidden>
        {Array.from({ length: 16 }).map((_, i) => (
          <div className="cell" key={i} />
        ))}
        {sample.map((v, i) => (
          <div
            key={i}
            className="tile"
            style={{ "--row": Math.floor(i / 4), "--col": i % 4 } as CSSProperties}
          >
            <div className="tile-inner" data-v={v}>
              {v}
            </div>
          </div>
        ))}
      </div>
      <a className="btn" href="https://farcaster.xyz/yura" target="_blank" rel="noreferrer">
        Open in Farcaster
      </a>
    </div>
  );
}

function Game({ auth }: { auth: AuthState }) {
  // Local tile mirror for animations. Truth lives on the server (in the
  // active_games row); we only keep enough client state to render smoothly.
  const [tiles, setTiles] = useState<Tile[]>([]);
  const [score, setScore] = useState(0);
  const [moves, setMoves] = useState(0);
  const [over, setOver] = useState(false);
  const [finished, setFinished] = useState(false);
  const [best, setBest] = useState(0);
  const [hydrated, setHydrated] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [showLeaderboard, setShowLeaderboard] = useState(false);

  const seedRef = useRef<number>(0);
  const moveLogRef = useRef<string>("");
  const rngRef = useRef<Rng>(() => 0);
  const tilesRef = useRef<Tile[]>([]);
  const overRef = useRef<boolean>(false);
  const finishedRef = useRef<boolean>(false);
  const submittingRef = useRef<boolean>(false);
  const submittedRef = useRef<boolean>(false);
  const undoActiveRef = useRef<boolean>(false);
  const inFlightRef = useRef<boolean>(false);
  const queueRef = useRef<Array<{ dir: "u" | "d" | "l" | "r"; expectedLen: number }>>([]);

  const [undoStatus, setUndoStatus] = useState<"idle" | "paying" | "confirming">("idle");
  const [undoError, setUndoError] = useState<string | null>(null);

  // Re-derive Tile[] (with stable ids and isNew/merged flags) by replaying
  // the server-provided move log against a fresh local rng. This keeps tile
  // animations working while the server stays the source of truth.
  const syncFromServer = useCallback((s: GameState) => {
    seedRef.current = s.seed;
    moveLogRef.current = s.move_log;
    rngRef.current = mulberry32(s.seed);
    let t = newGameTiles(rngRef.current);
    let sc = 0;
    let mv = 0;
    for (const ch of s.move_log) {
      const dir = DIR_FROM_CHAR[ch];
      if (!dir) continue;
      const r = move(t, dir);
      if (!r.moved) continue;
      t = spawnTile(r.tiles, rngRef.current);
      sc += r.gained;
      mv++;
    }
    tilesRef.current = t;
    overRef.current = s.over;
    finishedRef.current = s.finished;
    setTiles(t);
    setScore(sc);
    setMoves(mv);
    setOver(s.over);
    setFinished(s.finished);
    if (s.finished) {
      submittedRef.current = true;
      setSubmitted(true);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        let s = await fetchGameState(auth.fetcher);
        if (!s || s.finished) {
          s = await startGame(auth.fetcher);
        }
        if (cancelled) return;
        syncFromServer(s);
        setHydrated(true);
      } catch {
        try {
          const s = await startGame(auth.fetcher);
          if (cancelled) return;
          syncFromServer(s);
          setHydrated(true);
        } catch {
          // give up; stays in loading state
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [auth.fetcher, syncFromServer]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const me = await fetchMyScore(auth.fetcher);
        if (cancelled) return;
        setBest(me?.score ?? 0);
      } catch {
        // ignore
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [auth.fetcher]);

  useEffect(() => {
    if (score > best) setBest(score);
  }, [score, best]);

  // Authoritative submit: only fires once the queue has drained and the
  // server confirms the game is over. Triggered from drainQueue, never from
  // optimistic UI state — otherwise we could submit before the server has
  // received the killing move.
  const trySubmit = useCallback(() => {
    if (!overRef.current) return;
    if (submittingRef.current || submittedRef.current || finishedRef.current) return;
    if (queueRef.current.length || inFlightRef.current) return;
    submittingRef.current = true;
    submitScore(
      { username: auth.user.username, pfp_url: auth.user.pfpUrl },
      auth.fetcher
    )
      .then((row) => {
        submittedRef.current = true;
        setSubmitted(true);
        setBest((b) => Math.max(b, row.score));
      })
      .catch(() => {
        // user can retry via new game
      })
      .finally(() => {
        submittingRef.current = false;
      });
  }, [auth]);

  // On rare desync (server applied fewer moves than we expected), pull the
  // full state — including move_log — and replay it locally to rebuild tiles.
  const resyncFromServer = useCallback(async () => {
    queueRef.current = [];
    try {
      const s = await fetchGameState(auth.fetcher);
      if (s) syncFromServer(s);
    } catch {
      // give up; user can hit New game
    }
  }, [auth.fetcher, syncFromServer]);

  // Drain the entire pending queue into a single batched POST. Bursts of
  // rapid input cost one round-trip instead of N — keeps gameplay smooth.
  const drainQueue = useCallback(() => {
    if (inFlightRef.current) return;
    if (!queueRef.current.length) {
      if (overRef.current) trySubmit();
      return;
    }
    const batch = queueRef.current;
    queueRef.current = [];
    const dirs = batch.map((b) => b.dir).join("");
    const expectedLen = batch[0].expectedLen;
    const expectedAfter = expectedLen + batch.length;

    inFlightRef.current = true;
    postMove(dirs, expectedLen, auth.fetcher)
      .then((res) => {
        if (res.ok) {
          if (res.state.log_len !== expectedAfter) {
            void resyncFromServer();
          }
        } else {
          void resyncFromServer();
        }
      })
      .finally(() => {
        inFlightRef.current = false;
        drainQueue();
      });
  }, [auth.fetcher, resyncFromServer, trySubmit]);

  const apply = useCallback(
    (dir: Direction) => {
      if (overRef.current) return;
      if (undoActiveRef.current) return;
      if (!hydrated) return;
      const result = move(tilesRef.current, dir);
      if (!result.moved) return;

      const expectedLen = moveLogRef.current.length;
      const next = spawnTile(result.tiles, rngRef.current);
      const newLog = moveLogRef.current + DIR_TO_CHAR[dir];
      const dead = !canMove(next);

      tilesRef.current = next;
      moveLogRef.current = newLog;
      if (dead) overRef.current = true;
      setTiles(next);
      setScore((s) => s + result.gained);
      setMoves((m) => m + 1);
      if (dead) setOver(true);

      queueRef.current.push({ dir: DIR_TO_CHAR[dir], expectedLen });
      // Defer the network kick to a microtask so React can commit the
      // optimistic frame before fetch() does any work on the main thread.
      queueMicrotask(drainQueue);
    },
    [hydrated, drainQueue]
  );

  const startFresh = useCallback(async () => {
    queueRef.current = [];
    inFlightRef.current = false;
    submittedRef.current = false;
    submittingRef.current = false;
    finishedRef.current = false;
    undoActiveRef.current = false;
    setSubmitted(false);
    setUndoError(null);
    setUndoStatus("idle");
    try {
      const s = await startGame(auth.fetcher);
      syncFromServer(s);
    } catch {
      // ignore
    }
  }, [auth.fetcher, syncFromServer]);

  const triggerUndo = useCallback(async () => {
    if (undoStatus !== "idle") return;
    if (overRef.current) return;
    if (moveLogRef.current.length === 0) return;
    setUndoError(null);
    setUndoStatus("paying");
    undoActiveRef.current = true;
    try {
      // Server hands out a per-intent unique amount; the nonce embedded in
      // the value is what binds this on-chain payment to our fid.
      const intent = await fetchUndoIntent(auth.fetcher);
      const txHash = await payForUndo({
        treasury: intent.treasury,
        amountWei: intent.amount_wei,
      });
      setUndoStatus("confirming");
      const s = await postUndo(txHash, auth.fetcher);
      queueRef.current = [];
      syncFromServer(s);
    } catch (err: unknown) {
      const e = err as { message?: string; code?: number };
      if (e.code !== 4001) {
        setUndoError(e.message ?? "undo failed");
      }
    } finally {
      undoActiveRef.current = false;
      setUndoStatus("idle");
    }
  }, [auth.fetcher, undoStatus, syncFromServer]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const map: Record<string, Direction> = {
        ArrowUp: "up",
        ArrowDown: "down",
        ArrowLeft: "left",
        ArrowRight: "right",
        w: "up",
        s: "down",
        a: "left",
        d: "right",
        W: "up",
        S: "down",
        A: "left",
        D: "right",
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

  const sortedTiles = useMemo(() => [...tiles].sort((a, b) => a.id - b.id), [tiles]);
  const displayName = auth.user.username ?? `fid:${auth.user.fid}`;
  const maxTile = maxTileValue(tiles);

  const undoDisabled =
    !hydrated || over || finished || moves === 0 || undoStatus !== "idle";
  const undoLabel = (() => {
    if (undoStatus === "paying") return "Confirm in wallet…";
    if (undoStatus === "confirming") return "Confirming…";
    return "Undo · $1";
  })();

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
        <div className="player">
          {auth.user.pfpUrl && <img src={auth.user.pfpUrl} alt="" className="pfp" />}
          <span>{displayName}</span>
        </div>
        <button className="btn ghost" onClick={() => setShowLeaderboard(true)}>
          Leaderboard
        </button>
      </div>

      <div className="action-row">
        <button
          className="btn ghost"
          onClick={triggerUndo}
          disabled={undoDisabled}
          title="Costs $1 in ETH on Base. Removes your last move."
        >
          {undoLabel}
        </button>
        <button className="btn" onClick={startFresh}>
          New game
        </button>
      </div>
      {undoError && <div className="muted error">Undo failed: {undoError}</div>}

      <div className="board" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
        {Array.from({ length: 16 }).map((_, i) => (
          <div className="cell" key={i} />
        ))}
        {!hydrated && <div className="board-loading">Loading…</div>}
        {sortedTiles.map((tile) => (
          <TileView
            key={tile.id}
            row={tile.row}
            col={tile.col}
            value={tile.value}
            isNew={tile.isNew}
            merged={tile.merged}
          />
        ))}
      </div>

      <div className={`status${over ? " lose" : ""}`}>
        {over ? "No moves left." : `Moves: ${moves} · Max tile: ${maxTile}`}
      </div>

      {showLeaderboard && (
        <LeaderboardModal currentFid={auth.user.fid} onClose={() => setShowLeaderboard(false)} />
      )}
    </div>
  );
}

function LeaderboardModal({
  currentFid,
  onClose,
}: {
  currentFid: number;
  onClose: () => void;
}) {
  const [rows, setRows] = useState<ScoreRow[]>([]);
  const [page, setPage] = useState(0);
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

  const loadMore = useCallback(async () => {
    setLoading(true);
    try {
      const next = await fetchScores(PAGE_SIZE, page * PAGE_SIZE);
      setRows((prev) => [...prev, ...next]);
      if (next.length < PAGE_SIZE) setDone(true);
      setPage((p) => p + 1);
      setError(null);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [page]);

  const didInitial = useRef(false);
  useEffect(() => {
    if (didInitial.current) return;
    didInitial.current = true;
    loadMore();
  }, [loadMore]);

  useEffect(() => {
    if (done) return;
    const el = sentinelRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && !loading) loadMore();
      },
      { rootMargin: "120px" }
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [loadMore, loading, done]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h2>Leaderboard</h2>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>
        <div className="modal-body">
          {error && <div className="muted">Error: {error}</div>}
          {rows.length === 0 && !loading && !error && (
            <div className="muted">Empty so far — be the first.</div>
          )}
          {rows.length > 0 && (
            <table>
              <thead>
                <tr>
                  <th className="rank">#</th>
                  <th>Player</th>
                  <th className="num">Score</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((s, i) => (
                  <tr
                    key={s.fid}
                    className={`row-clickable${s.fid === currentFid ? " me" : ""}`}
                    onClick={() => {
                      sdk.actions.viewProfile({ fid: s.fid }).catch(() => {});
                    }}
                  >
                    <td className="rank">{i + 1}</td>
                    <td>
                      <div className="player-cell">
                        {s.pfp_url && <img src={s.pfp_url} alt="" className="pfp small" />}
                        <span>{s.username ?? `fid:${s.fid}`}</span>
                      </div>
                    </td>
                    <td className="num">{s.score}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div ref={sentinelRef} className="sentinel">
            {loading && <div className="muted">Loading…</div>}
            {done && rows.length > 0 && <div className="muted">— end —</div>}
          </div>
        </div>
      </div>
    </div>
  );
}
