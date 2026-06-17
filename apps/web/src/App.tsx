import { type CSSProperties, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import sdk from "@farcaster/miniapp-sdk";
import {
  canMove,
  move,
  mulberry32,
  newGameTiles,
  spawnTile,
  type Direction,
  type Rng,
  type Tile,
} from "./game";
import {
  buyPack,
  createShare,
  fetchGameState,
  fetchMe,
  fetchMyScore,
  fetchPackIntent,
  fetchScores,
  postMove,
  postUndo,
  previewShare,
  startGame,
  submitScore,
  type GameState,
  type Pack,
  type ScoreRow,
} from "./api";
import { payTreasury } from "./wallet";

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
  const [gameOverModal, setGameOverModal] = useState<null | {
    score: number;
    newBest: boolean;
  }>(null);

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
  const [undoCredits, setUndoCredits] = useState<number>(0);
  const [showShop, setShowShop] = useState(false);

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
    let cancelled = false;
    (async () => {
      try {
        const me = await fetchMe(auth.fetcher);
        if (cancelled) return;
        setUndoCredits(me.undo_credits);
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
      .then((res) => {
        submittedRef.current = true;
        setSubmitted(true);
        setBest((b) => Math.max(b, res.score.score));
        // Pop the share modal as soon as the server-authoritative submit lands
        // — that's the moment we know the rank is meaningful (it would still
        // be stale if we opened on the optimistic `over` flag).
        setGameOverModal({
          score: res.last_game.score,
          newBest: res.new_best,
        });
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
    setGameOverModal(null);
    try {
      const s = await startGame(auth.fetcher);
      syncFromServer(s);
    } catch {
      // ignore
    }
  }, [auth.fetcher, syncFromServer]);

  const triggerUndo = useCallback(async () => {
    if (undoStatus !== "idle") return;
    if (undoCredits <= 0) {
      // No credits → "Purchase Undo" route. Always available, even with no
      // moves yet or game over, so users can stock up at any time.
      setShowShop(true);
      return;
    }
    if (overRef.current) return;
    if (moveLogRef.current.length === 0) return;
    setUndoError(null);
    setUndoStatus("confirming");
    undoActiveRef.current = true;
    try {
      const res = await postUndo(auth.fetcher);
      if (!res.ok) {
        if (res.status === 402) {
          // Credit balance fell out from under us — refresh and open shop.
          setUndoCredits(res.undo_credits ?? 0);
          setShowShop(true);
          return;
        }
        throw new Error(res.error);
      }
      queueRef.current = [];
      syncFromServer(res.state);
      setUndoCredits(res.undo_credits);
    } catch (err: unknown) {
      const e = err as { message?: string };
      setUndoError(`Undo failed: ${e.message ?? "unknown error"}`);
    } finally {
      undoActiveRef.current = false;
      setUndoStatus("idle");
    }
  }, [auth.fetcher, undoStatus, undoCredits, syncFromServer]);

  const buyAndCredit = useCallback(
    async (packId: Pack["id"]) => {
      try {
        const intent = await fetchPackIntent(packId, auth.fetcher);
        const txHash = await payTreasury({
          treasury: intent.treasury,
          amountWei: intent.amount_wei,
        });
        // payTreasury resolves on submission, not on mining, so /buy returns
        // "pending" until the tx confirms. Poll until it's credited (Base
        // blocks land in seconds) while staying well inside the intent TTL.
        const deadline = Date.now() + 120_000;
        let res = await buyPack(txHash, packId, auth.fetcher);
        while (res.status === "pending" && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 3000));
          res = await buyPack(txHash, packId, auth.fetcher);
        }
        if (res.status !== "credited") {
          // Still unconfirmed after the poll window. The payment is on-chain;
          // the reconciler credits it shortly even if we stop waiting here.
          setUndoError("Payment sent — credits will appear once it confirms.");
          return;
        }
        setUndoCredits(res.undo_credits);
        setShowShop(false);
      } catch (err: unknown) {
        const e = err as { message?: string; code?: number };
        if (e.code === 4001) return; // user rejected
        setUndoError(`Purchase failed: ${e.message ?? "unknown error"}`);
      }
    },
    [auth.fetcher]
  );

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
  // Whether this gesture has already fired a move. Firing mid-drag (on
  // touchmove, as soon as the finger crosses the threshold) rather than on
  // touchend makes the swipe feel as instant as a key press — there's no wait
  // for the finger to lift. One move per gesture; the flag blocks re-fires.
  const swipeFired = useRef(false);
  const onTouchStart = (e: React.TouchEvent) => {
    const t = e.touches[0];
    touchStart.current = { x: t.clientX, y: t.clientY };
    swipeFired.current = false;
  };
  const onTouchMove = (e: React.TouchEvent) => {
    if (!touchStart.current || swipeFired.current) return;
    const t = e.touches[0];
    const dx = t.clientX - touchStart.current.x;
    const dy = t.clientY - touchStart.current.y;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < 24) return;
    swipeFired.current = true;
    if (Math.abs(dx) > Math.abs(dy)) apply(dx > 0 ? "right" : "left");
    else apply(dy > 0 ? "down" : "up");
  };
  const onTouchEnd = () => {
    touchStart.current = null;
  };

  const sortedTiles = useMemo(() => [...tiles].sort((a, b) => a.id - b.id), [tiles]);
  const displayName = auth.user.username ?? `fid:${auth.user.fid}`;

  const noCredits = undoCredits <= 0;
  // When the user has no credits the button is always active (it opens the
  // shop). With credits, normal undo gating applies — must have made moves
  // and not be in game-over/finished/loading state.
  const undoDisabled =
    !hydrated ||
    finished ||
    undoStatus !== "idle" ||
    (!noCredits && (over || moves === 0));
  const undoLabel = (() => {
    if (undoStatus === "confirming") return "Undoing…";
    if (noCredits) return "Purchase Undo";
    return `Undo · ${undoCredits} left`;
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
          title={
            noCredits
              ? "No undo credits — tap to buy a pack."
              : "Removes your last move."
          }
        >
          {undoLabel}
        </button>
        <button className="btn" onClick={startFresh}>
          New Game
        </button>
      </div>
      {undoError && <div className="muted error">{undoError}</div>}

      <div
        className="board"
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
      >
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
        <span className="status-info">
          {over ? "No moves left." : `Moves: ${moves}`}
        </span>
        <span className="status-hint">Arrow keys or swipe to move</span>
      </div>

      {showLeaderboard && (
        <LeaderboardModal currentFid={auth.user.fid} onClose={() => setShowLeaderboard(false)} />
      )}

      {gameOverModal && (
        <GameOverModal
          fetcher={auth.fetcher}
          score={gameOverModal.score}
          newBest={gameOverModal.newBest}
          onClose={() => setGameOverModal(null)}
          onPlayAgain={() => {
            setGameOverModal(null);
            void startFresh();
          }}
        />
      )}

      {showShop && (
        <ShopModal
          credits={undoCredits}
          onBuy={buyAndCredit}
          onClose={() => setShowShop(false)}
        />
      )}
    </div>
  );
}

// Anchor pricing — best-value pack at the top so the value-driving option is
// the first thing the eye lands on.
type ShopPack = {
  id: Pack["id"];
  undos: number;
  ethDisplay: string;
  usd: number;
  variant: "best" | "popular" | "starter";
};

const SHOP_PACKS: ShopPack[] = [
  { id: "large",  undos: 100, ethDisplay: "0.0043", usd: 10, variant: "best" },
  { id: "medium", undos: 15,  ethDisplay: "0.0013", usd: 3,  variant: "popular" },
  { id: "small",  undos: 3,   ethDisplay: "0.0004", usd: 1,  variant: "starter" },
];

// Canonical Ethereum diamond logo. Renders at currentColor so it inherits
// the surrounding text colour on each pack variant.
function EthGlyph() {
  return (
    <svg
      className="eth-glyph"
      viewBox="0 0 256 417"
      width="0.78em"
      height="0.78em"
      aria-hidden="true"
      focusable="false"
    >
      <path fill="currentColor" opacity=".55" d="M127.961 0l-2.795 9.5v275.668l2.795 2.79 127.962-75.638z" />
      <path fill="currentColor" d="M127.962 0L0 212.32l127.962 75.639V154.158z" />
      <path fill="currentColor" opacity=".55" d="M127.961 312.187l-1.575 1.92v98.199l1.575 4.6L256 236.587z" />
      <path fill="currentColor" d="M127.962 416.905v-104.72L0 236.585z" />
      <path fill="currentColor" opacity=".22" d="M127.961 287.958l127.96-75.637-127.96-58.162z" />
      <path fill="currentColor" opacity=".55" d="M0 212.32l127.96 75.638v-133.8z" />
    </svg>
  );
}

type ShopModalProps = {
  credits: number;
  onBuy: (pack: Pack["id"]) => Promise<void> | void;
  onClose: () => void;
};

function ShopModal({ credits, onBuy, onClose }: ShopModalProps) {
  const [busy, setBusy] = useState<Pack["id"] | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const click = async (pack: Pack["id"]) => {
    if (busy) return;
    setBusy(pack);
    try {
      await onBuy(pack);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      className="shop-backdrop"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="shop-title"
    >
      <section className="shop" onClick={(e) => e.stopPropagation()}>
        <header className="shop-head">
          <div>
            <p className="shop-eyebrow">Refill</p>
            <h2 className="shop-title" id="shop-title">Pick a pack</h2>
            <p className="shop-sub">
              You have <b>{credits}</b> undo{credits === 1 ? "" : "s"} left — credits never expire.
            </p>
          </div>
          <button className="shop-close" onClick={onClose} aria-label="Close" type="button">
            ×
          </button>
        </header>

        <div className="packs">
          {SHOP_PACKS.map((p) => (
            <button
              key={p.id}
              type="button"
              className={`pack pack--${p.variant}${busy === p.id ? " pack--busy" : ""}`}
              onClick={() => void click(p.id)}
              disabled={busy !== null}
            >
              <span className="pack-amount">
                <span className="pack-num">{p.undos}</span>
                <span className="pack-unit">undos</span>
              </span>
              <span className="pack-gap" />
              <span className="pack-price">
                <span className="pack-eth">
                  <EthGlyph />
                  {p.ethDisplay}
                </span>
                <span className="pack-meta">≈ ${p.usd}</span>
              </span>
              {busy === p.id && <span className="pack-overlay">Confirm in wallet…</span>}
            </button>
          ))}
        </div>

        <p className="shop-foot">
          <span>Paid in ETH on Base</span>
          <span className="dot" aria-hidden="true" />
          <span>Auto-refills your balance</span>
        </p>
      </section>
    </div>
  );
}

type GameOverModalProps = {
  fetcher: typeof fetch;
  score: number;
  newBest: boolean;
  onClose: () => void;
  onPlayAgain: () => void;
};

function GameOverModal({
  fetcher,
  score,
  newBest,
  onClose,
  onPlayAgain,
}: GameOverModalProps) {
  const [phase, setPhase] = useState<"idle" | "preparing" | "composing">("idle");
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [rank, setRank] = useState<number | null>(null);
  // Strict mode in dev fires effects twice — without this we'd burn two
  // preview renders and eat into our share rate limit on first render.
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    setPhase("preparing");
    setError(null);
    previewShare(fetcher)
      .then((res) => {
        setPreview(res.image_data_url);
        setRank(res.rank);
      })
      .catch((err) => {
        setError(String(err?.message ?? err));
      })
      .finally(() => setPhase("idle"));
  }, [fetcher]);

  const onShare = useCallback(async () => {
    setError(null);
    setPhase("composing");
    try {
      // Persist the share image to S3 only now that the user has committed
      // to sharing. Costs an extra render server-side, but keeps the bucket
      // free of images for closed-modal sessions.
      const created = await createShare(fetcher);
      const scoreText = score.toLocaleString("en-US");
      const rankText = rank ? ` (#${rank})` : "";
      const text = newBest
        ? `New personal best on 2048 — ${scoreText}${rankText}. Think you can beat that?`
        : `${scoreText} on 2048${rankText}. Who's coming for me?`;
      await sdk.actions.composeCast({
        text,
        embeds: [created.share_url],
      });
    } catch (err) {
      setError(String((err as { message?: string })?.message ?? err));
    } finally {
      setPhase("idle");
    }
  }, [fetcher, newBest, score, rank]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal gameover-modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h2>{newBest ? "New best!" : "Game over"}</h2>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>
        <div className="modal-body">
          <div className="gameover-preview">
            {phase === "preparing" && !preview && (
              <div className="muted">Generating share image…</div>
            )}
            {preview && (
              <img src={preview} alt="2048 share card" className="gameover-preview-img" />
            )}
            {error && <div className="muted error">{error}</div>}
          </div>

          <div className="gameover-actions">
            <button className="btn ghost" onClick={onPlayAgain}>
              Play again
            </button>
            <button
              className="btn"
              onClick={onShare}
              disabled={phase !== "idle" || !preview}
            >
              {phase === "composing" ? "Opening…" : "Share to Farcaster"}
            </button>
          </div>
        </div>
      </div>
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
