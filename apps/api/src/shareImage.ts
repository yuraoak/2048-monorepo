import satori from "satori";
import { Resvg } from "@resvg/resvg-js";
import sharp from "sharp";

// 3:2 aspect ratio is required by Farcaster mini-app embeds (min 600x400,
// max 3000x2000). 1200x800 hits the sweet spot — sharp text, ~80–150 KB PNG.
export const SHARE_IMAGE_WIDTH = 1200;
export const SHARE_IMAGE_HEIGHT = 800;

const FONT_REGULAR_URL =
  "https://github.com/rsms/inter/raw/v3.19/docs/font-files/Inter-Regular.otf";
const FONT_BOLD_URL =
  "https://github.com/rsms/inter/raw/v3.19/docs/font-files/Inter-Bold.otf";

let fontCache: { regular: ArrayBuffer; bold: ArrayBuffer } | null = null;

async function loadFonts() {
  if (fontCache) return fontCache;
  const [reg, bold] = await Promise.all([
    fetch(FONT_REGULAR_URL).then((r) => {
      if (!r.ok) throw new Error(`font fetch ${r.status}`);
      return r.arrayBuffer();
    }),
    fetch(FONT_BOLD_URL).then((r) => {
      if (!r.ok) throw new Error(`font fetch ${r.status}`);
      return r.arrayBuffer();
    }),
  ]);
  fontCache = { regular: reg, bold };
  return fontCache;
}

// Tile colours mirror the in-game palette in apps/web/src/styles.css. Keep
// these in sync with the client so the share image looks like the board the
// player just saw.
const TILE_COLORS: Record<number, { bg: string; fg: string }> = {
  0: { bg: "#cdc1b4", fg: "#cdc1b4" },
  2: { bg: "#eee4da", fg: "#776e65" },
  4: { bg: "#ede0c8", fg: "#776e65" },
  8: { bg: "#f2b179", fg: "#f9f6f2" },
  16: { bg: "#f59563", fg: "#f9f6f2" },
  32: { bg: "#f67c5f", fg: "#f9f6f2" },
  64: { bg: "#f65e3b", fg: "#f9f6f2" },
  128: { bg: "#edcf72", fg: "#f9f6f2" },
  256: { bg: "#edcc61", fg: "#f9f6f2" },
  512: { bg: "#edc850", fg: "#f9f6f2" },
  1024: { bg: "#edc53f", fg: "#f9f6f2" },
  2048: { bg: "#edc22e", fg: "#f9f6f2" },
};
const HIGH_TILE = { bg: "#3c3a32", fg: "#f9f6f2" };

function tileColors(value: number) {
  if (value === 0) return TILE_COLORS[0];
  return TILE_COLORS[value] ?? HIGH_TILE;
}

function tileFontSize(value: number): number {
  if (value < 100) return 60;
  if (value < 1000) return 48;
  if (value < 10000) return 38;
  if (value < 100000) return 32;
  return 26;
}

// Avatars on Farcaster come in arbitrary formats — JPEG, PNG, WebP, GIF
// (animated), occasionally SVG. We normalize to a circular 240×240 PNG so
// the share image renderer never has to think about format quirks. sharp
// reads the first frame of animated GIF/WebP by default, which is what we
// want for a still share card.
async function fetchAvatarPng(url: string | null): Promise<Buffer | null> {
  if (!url) return null;
  try {
    const res = await fetch(url, {
      headers: { "user-agent": "2048-miniapp-share/1.0" },
      // 5s budget — share creation must stay snappy.
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    const square = await sharp(buf, { animated: false })
      .resize(240, 240, { fit: "cover", position: "centre" })
      .png()
      .toBuffer();
    const mask = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240"><circle cx="120" cy="120" r="120" fill="#fff"/></svg>`
    );
    return await sharp(square)
      .composite([{ input: mask, blend: "dest-in" }])
      .png()
      .toBuffer();
  } catch {
    return null;
  }
}

export type ShareImageInput = {
  board: number[][];
  score: number;
  rank: number | null;
  maxTile: number;
  username: string | null;
  avatarUrl: string | null;
  fid: number;
};

export async function renderShareImage(input: ShareImageInput): Promise<Buffer> {
  const fonts = await loadFonts();
  const avatarPng = await fetchAvatarPng(input.avatarUrl);
  const avatarDataUrl = avatarPng
    ? `data:image/png;base64,${avatarPng.toString("base64")}`
    : null;

  const displayName =
    input.username && input.username.length > 0
      ? `@${input.username}`
      : `fid:${input.fid}`;

  const rankLabel =
    input.rank == null
      ? "—"
      : input.rank === 1
      ? "#1"
      : `#${input.rank}`;

  // Score card has ~200px of usable text width; the font has to scale down
  // for big numbers so "4,000,000" (theoretical max) doesn't overflow the
  // card. Typical scores stay at the hero 64px size.
  const scoreText = input.score.toLocaleString("en-US");
  const scoreFontPx = scoreText.length <= 6 ? 64 : scoreText.length <= 7 ? 54 : 44;

  // Layout: left half = 4×4 board on a 560×560 plate. Tile/gap/padding sizes
  // are chosen so 4×116 + 3×16 + 2×24 = 560 fits the plate exactly — earlier
  // numbers (115 / 15 / 20) left 15px of dead space, biasing tiles to the
  // top-left and looking visibly off-center.
  const tile = (value: number) => {
    const c = tileColors(value);
    return {
      type: "div" as const,
      key: undefined,
      props: {
        style: {
          width: "116px",
          height: "116px",
          background: c.bg,
          color: c.fg,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          borderRadius: "10px",
          fontSize: `${tileFontSize(value)}px`,
          fontWeight: 700,
        },
        children: value === 0 ? "" : String(value),
      },
    };
  };

  const boardRows = input.board.map((row, ri) => ({
    type: "div" as const,
    key: ri,
    props: {
      style: {
        display: "flex",
        gap: "16px",
      },
      children: row.map((v, ci) => ({
        ...tile(v),
        key: ci,
      })),
    },
  }));

  const node = {
    type: "div",
    key: undefined,
    props: {
      style: {
        width: `${SHARE_IMAGE_WIDTH}px`,
        height: `${SHARE_IMAGE_HEIGHT}px`,
        display: "flex",
        background: "#faf8ef",
        padding: "60px",
        fontFamily: "Inter",
        color: "#776e65",
      },
      children: [
        {
          type: "div",
          props: {
            style: {
              width: "560px",
              height: "560px",
              background: "#bbada0",
              padding: "24px",
              borderRadius: "16px",
              display: "flex",
              flexDirection: "column",
              gap: "16px",
              alignSelf: "center",
            },
            children: boardRows,
          },
        },
        {
          type: "div",
          props: {
            style: {
              flex: 1,
              height: "560px",
              alignSelf: "center",
              display: "flex",
              flexDirection: "column",
              justifyContent: "space-between",
              paddingLeft: "60px",
            },
            children: [
              {
                type: "div",
                props: {
                  style: {
                    display: "flex",
                    alignItems: "center",
                    gap: "28px",
                  },
                  children: [
                    avatarDataUrl
                      ? {
                          type: "img",
                          props: {
                            src: avatarDataUrl,
                            width: 112,
                            height: 112,
                            style: { borderRadius: "50%" },
                          },
                        }
                      : {
                          type: "div",
                          props: {
                            style: {
                              width: "112px",
                              height: "112px",
                              borderRadius: "50%",
                              background: "#cdc1b4",
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "center",
                              fontSize: "48px",
                              fontWeight: 700,
                              color: "#776e65",
                            },
                            children: (
                              input.username?.[0] ??
                              String(input.fid)[0] ??
                              "?"
                            ).toUpperCase(),
                          },
                        },
                    {
                      type: "div",
                      props: {
                        style: {
                          fontSize: "56px",
                          fontWeight: 700,
                          color: "#5e544a",
                          maxWidth: "340px",
                          overflow: "hidden",
                          whiteSpace: "nowrap",
                          textOverflow: "ellipsis",
                          lineHeight: 1.1,
                        },
                        children: displayName,
                      },
                    },
                  ],
                },
              },
              {
                type: "div",
                props: {
                  style: { display: "flex", gap: "24px" },
                  children: [
                    {
                      type: "div",
                      props: {
                        style: {
                          width: "180px",
                          background: "#bbada0",
                          color: "#f9f6f2",
                          borderRadius: "16px",
                          padding: "26px 28px",
                          display: "flex",
                          flexDirection: "column",
                          gap: "10px",
                        },
                        children: [
                          {
                            type: "div",
                            props: {
                              style: {
                                fontSize: "22px",
                                opacity: 0.85,
                                textTransform: "uppercase",
                                letterSpacing: "2px",
                                fontWeight: 700,
                              },
                              children: "Rank",
                            },
                          },
                          {
                            type: "div",
                            props: {
                              style: { fontSize: "64px", fontWeight: 700, lineHeight: 1 },
                              children: rankLabel,
                            },
                          },
                        ],
                      },
                    },
                    {
                      type: "div",
                      props: {
                        style: {
                          flex: 1,
                          background: "#bbada0",
                          color: "#f9f6f2",
                          borderRadius: "16px",
                          padding: "26px 28px",
                          display: "flex",
                          flexDirection: "column",
                          gap: "10px",
                        },
                        children: [
                          {
                            type: "div",
                            props: {
                              style: {
                                fontSize: "22px",
                                opacity: 0.85,
                                textTransform: "uppercase",
                                letterSpacing: "2px",
                                fontWeight: 700,
                              },
                              children: "Score",
                            },
                          },
                          {
                            type: "div",
                            props: {
                              style: { fontSize: `${scoreFontPx}px`, fontWeight: 700, lineHeight: 1 },
                              children: scoreText,
                            },
                          },
                        ],
                      },
                    },
                  ],
                },
              },
            ],
          },
        },
      ],
    },
  };

  const svg = await satori(node as never, {
    width: SHARE_IMAGE_WIDTH,
    height: SHARE_IMAGE_HEIGHT,
    fonts: [
      { name: "Inter", data: fonts.regular, weight: 400, style: "normal" },
      { name: "Inter", data: fonts.bold, weight: 700, style: "normal" },
    ],
  });

  const png = new Resvg(svg, {
    fitTo: { mode: "width", value: SHARE_IMAGE_WIDTH },
  })
    .render()
    .asPng();

  return Buffer.from(png);
}
