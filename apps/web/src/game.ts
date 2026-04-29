export type Direction = "up" | "down" | "left" | "right";
export type Tile = {
  id: number;
  value: number;
  row: number;
  col: number;
  isNew?: boolean;
  merged?: boolean;
};

export const SIZE = 4;

export type Rng = () => number;

export function mulberry32(seed: number): Rng {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let _id = 1;
function nextId() {
  return _id++;
}

export function newGameTiles(rng: Rng): Tile[] {
  let tiles: Tile[] = [];
  tiles = spawnTile(tiles, rng);
  tiles = spawnTile(tiles, rng);
  return tiles;
}

export function spawnTile(tiles: Tile[], rng: Rng): Tile[] {
  const occupied = new Set<string>();
  for (const t of tiles) occupied.add(`${t.row},${t.col}`);
  const empties: Array<[number, number]> = [];
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (!occupied.has(`${r},${c}`)) empties.push([r, c]);
    }
  }
  if (empties.length === 0) return tiles;
  const [r, c] = empties[Math.floor(rng() * empties.length)];
  const value = rng() < 0.9 ? 2 : 4;
  return [...tiles, { id: nextId(), value, row: r, col: c, isNew: true }];
}

export function move(
  tiles: Tile[],
  dir: Direction
): { tiles: Tile[]; gained: number; moved: boolean } {
  let gained = 0;
  let moved = false;
  const result: Tile[] = [];
  const isHorizontal = dir === "left" || dir === "right";

  for (let line = 0; line < SIZE; line++) {
    const inLine = tiles.filter((t) => (isHorizontal ? t.row : t.col) === line);
    inLine.sort((a, b) => {
      const av = isHorizontal ? a.col : a.row;
      const bv = isHorizontal ? b.col : b.row;
      return dir === "right" || dir === "down" ? bv - av : av - bv;
    });

    const placed: Array<{ tile: Tile; canMerge: boolean }> = [];
    let pos = 0;

    for (const tile of inLine) {
      const last = placed[placed.length - 1];
      if (last && last.canMerge && last.tile.value === tile.value) {
        last.tile.value *= 2;
        last.tile.merged = true;
        last.canMerge = false;
        gained += last.tile.value;
        moved = true;
      } else {
        const dst = dir === "left" || dir === "up" ? pos : SIZE - 1 - pos;
        const newRow = isHorizontal ? line : dst;
        const newCol = isHorizontal ? dst : line;
        if (newRow !== tile.row || newCol !== tile.col) moved = true;
        placed.push({
          tile: { id: tile.id, value: tile.value, row: newRow, col: newCol },
          canMerge: true,
        });
        pos++;
      }
    }
    for (const p of placed) result.push(p.tile);
  }

  return { tiles: result, gained, moved };
}

export function maxTileValue(tiles: Tile[]): number {
  let m = 0;
  for (const t of tiles) if (t.value > m) m = t.value;
  return m;
}

export function canMove(tiles: Tile[]): boolean {
  if (tiles.length < SIZE * SIZE) return true;
  const grid: number[][] = Array.from({ length: SIZE }, () => Array(SIZE).fill(0));
  for (const t of tiles) grid[t.row][t.col] = t.value;
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (c + 1 < SIZE && grid[r][c] === grid[r][c + 1]) return true;
      if (r + 1 < SIZE && grid[r][c] === grid[r + 1][c]) return true;
    }
  }
  return false;
}

export function tilesToBoard(tiles: Tile[]): number[][] {
  const board = Array.from({ length: SIZE }, () => Array(SIZE).fill(0));
  for (const t of tiles) board[t.row][t.col] = t.value;
  return board;
}

export function boardToTiles(board: number[][]): Tile[] {
  const tiles: Tile[] = [];
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (board[r][c] > 0) tiles.push({ id: nextId(), value: board[r][c], row: r, col: c });
    }
  }
  return tiles;
}
