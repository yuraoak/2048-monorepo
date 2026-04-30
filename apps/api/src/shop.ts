// Undo packs. Prices are in wei, computed at a $2300 / ETH peg — this is a
// frozen reference rate, not live ETH/USD. If ETH price moves a lot the
// dollar-equivalents drift; we'd update these constants and redeploy.
//
// At $2300/ETH:
//   $1  ≈ 0.000435 ETH ≈ 434782608695652 wei
//   $3  ≈ 0.001304 ETH ≈ 1304347826086956 wei
//   $10 ≈ 0.004348 ETH ≈ 4347826086956521 wei

export type PackId = "small" | "medium" | "large";

export type Pack = {
  id: PackId;
  undos: number;
  priceWei: bigint;
};

export const UNDO_PACKS: Record<PackId, Pack> = {
  small:  { id: "small",  undos: 3,   priceWei: 434782608695652n },
  medium: { id: "medium", undos: 15,  priceWei: 1304347826086956n },
  large:  { id: "large",  undos: 100, priceWei: 4347826086956521n },
};

export function isPackId(s: string): s is PackId {
  return s === "small" || s === "medium" || s === "large";
}
