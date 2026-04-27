export type Board = number[][];
export type Direction = "up" | "down" | "left" | "right";

const SIZE = 4;

export function emptyBoard(): Board {
  return Array.from({ length: SIZE }, () => Array<number>(SIZE).fill(0));
}

export function cloneBoard(b: Board): Board {
  return b.map((row) => row.slice());
}

export function spawnTile(b: Board): Board {
  const empty: Array<[number, number]> = [];
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (b[r][c] === 0) empty.push([r, c]);
    }
  }
  if (empty.length === 0) return b;
  const [r, c] = empty[Math.floor(Math.random() * empty.length)];
  const next = cloneBoard(b);
  next[r][c] = Math.random() < 0.9 ? 2 : 4;
  return next;
}

export function newGame(): Board {
  return spawnTile(spawnTile(emptyBoard()));
}

function compressLine(line: number[]): { line: number[]; gained: number } {
  const filtered = line.filter((v) => v !== 0);
  let gained = 0;
  for (let i = 0; i < filtered.length - 1; i++) {
    if (filtered[i] === filtered[i + 1]) {
      filtered[i] *= 2;
      gained += filtered[i];
      filtered.splice(i + 1, 1);
    }
  }
  while (filtered.length < SIZE) filtered.push(0);
  return { line: filtered, gained };
}

function rotateCW(b: Board): Board {
  const n = cloneBoard(b);
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      n[c][SIZE - 1 - r] = b[r][c];
    }
  }
  return n;
}

function rotateCCW(b: Board): Board {
  const n = cloneBoard(b);
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      n[SIZE - 1 - c][r] = b[r][c];
    }
  }
  return n;
}

function reverseRows(b: Board): Board {
  return b.map((row) => row.slice().reverse());
}

function moveLeft(b: Board): { board: Board; gained: number; moved: boolean } {
  let gained = 0;
  let moved = false;
  const next = b.map((row) => {
    const { line, gained: g } = compressLine(row);
    gained += g;
    if (!moved) {
      for (let i = 0; i < SIZE; i++) {
        if (row[i] !== line[i]) { moved = true; break; }
      }
    }
    return line;
  });
  return { board: next, gained, moved };
}

export function move(b: Board, dir: Direction): { board: Board; gained: number; moved: boolean } {
  let working = b;
  if (dir === "right") working = reverseRows(working);
  else if (dir === "up") working = rotateCCW(working);
  else if (dir === "down") working = rotateCW(working);

  const { board, gained, moved } = moveLeft(working);

  let result = board;
  if (dir === "right") result = reverseRows(result);
  else if (dir === "up") result = rotateCW(result);
  else if (dir === "down") result = rotateCCW(result);

  return { board: result, gained, moved };
}

export function maxTile(b: Board): number {
  let m = 0;
  for (const row of b) for (const v of row) if (v > m) m = v;
  return m;
}

export function canMove(b: Board): boolean {
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (b[r][c] === 0) return true;
      if (c + 1 < SIZE && b[r][c] === b[r][c + 1]) return true;
      if (r + 1 < SIZE && b[r][c] === b[r + 1][c]) return true;
    }
  }
  return false;
}

export function hasWon(b: Board): boolean {
  return maxTile(b) >= 2048;
}
