// Authoritative server-side replay of a 2048 game.
// Client sends (seed, moves); server reconstructs state with the same PRNG
// and merge logic. The score derived here is the only one that goes to DB.

export type Direction = "up" | "down" | "left" | "right";
type Board = number[][];

export const SIZE = 4;
export const MAX_MOVES = 100_000;

export function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DIR_FROM_CHAR: Record<string, Direction> = { u: "up", d: "down", l: "left", r: "right" };

function emptyBoard(): Board {
  return Array.from({ length: SIZE }, () => Array(SIZE).fill(0));
}

function spawn(b: Board, rng: () => number): Board {
  const cells: Array<[number, number]> = [];
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (b[r][c] === 0) cells.push([r, c]);
    }
  }
  if (!cells.length) return b;
  const [r, c] = cells[Math.floor(rng() * cells.length)];
  const value = rng() < 0.9 ? 2 : 4;
  const next = b.map((row) => row.slice());
  next[r][c] = value;
  return next;
}

function applyMove(b: Board, dir: Direction): { board: Board; gained: number; moved: boolean } {
  const next = emptyBoard();
  let gained = 0;
  let moved = false;
  const isHorizontal = dir === "left" || dir === "right";
  const reverse = dir === "right" || dir === "down";

  for (let line = 0; line < SIZE; line++) {
    const values: number[] = [];
    for (let i = 0; i < SIZE; i++) {
      const idx = reverse ? SIZE - 1 - i : i;
      const r = isHorizontal ? line : idx;
      const c = isHorizontal ? idx : line;
      const v = b[r][c];
      if (v !== 0) values.push(v);
    }

    const merged: number[] = [];
    let canMerge = false;
    for (const v of values) {
      if (canMerge && merged[merged.length - 1] === v) {
        merged[merged.length - 1] = v * 2;
        gained += v * 2;
        canMerge = false;
      } else {
        merged.push(v);
        canMerge = true;
      }
    }
    while (merged.length < SIZE) merged.push(0);

    for (let i = 0; i < SIZE; i++) {
      const idx = reverse ? SIZE - 1 - i : i;
      const r = isHorizontal ? line : idx;
      const c = isHorizontal ? idx : line;
      const v = merged[i];
      next[r][c] = v;
      if (v !== b[r][c]) moved = true;
    }
  }

  return { board: next, gained, moved };
}

function canMoveAny(b: Board): boolean {
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (b[r][c] === 0) return true;
      if (c + 1 < SIZE && b[r][c] === b[r][c + 1]) return true;
      if (r + 1 < SIZE && b[r][c] === b[r + 1][c]) return true;
    }
  }
  return false;
}

function maxTileValue(b: Board): number {
  let m = 0;
  for (const row of b) for (const v of row) if (v > m) m = v;
  return m;
}

export type ReplayResult = {
  score: number;
  max_tile: number;
  moves: number;
  board: number[][];
  over: boolean;
};

export function replay(seed: number, encodedMoves: string): ReplayResult {
  if (encodedMoves.length > MAX_MOVES) {
    throw new Error(`too many moves: ${encodedMoves.length}`);
  }
  if (!/^[udlr]*$/.test(encodedMoves)) {
    throw new Error("invalid move characters");
  }

  const rng = mulberry32(seed);
  let board = emptyBoard();
  board = spawn(board, rng);
  board = spawn(board, rng);

  let score = 0;
  let movesCount = 0;

  for (const ch of encodedMoves) {
    if (!canMoveAny(board)) break;
    const dir = DIR_FROM_CHAR[ch]!;
    const r = applyMove(board, dir);
    if (!r.moved) continue;
    board = spawn(r.board, rng);
    score += r.gained;
    movesCount++;
  }

  return {
    score,
    max_tile: maxTileValue(board),
    moves: movesCount,
    board,
    over: !canMoveAny(board),
  };
}
