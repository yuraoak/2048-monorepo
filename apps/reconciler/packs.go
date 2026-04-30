package main

import (
	"math/big"
	"sort"
)

// Mirror of apps/api/src/shop.ts. If pack prices change there, change here
// too — these are part of the on-chain → fid binding contract.
type Pack struct {
	ID       string
	Undos    int
	PriceWei *big.Int
}

var Packs = []Pack{
	{ID: "small", Undos: 3, PriceWei: mustBigInt("434782608695652")},
	{ID: "medium", Undos: 15, PriceWei: mustBigInt("1304347826086956")},
	{ID: "large", Undos: 100, PriceWei: mustBigInt("4347826086956521")},
}

var packsByPriceDesc []Pack

func init() {
	packsByPriceDesc = append(packsByPriceDesc, Packs...)
	sort.Slice(packsByPriceDesc, func(i, j int) bool {
		return packsByPriceDesc[i].PriceWei.Cmp(packsByPriceDesc[j].PriceWei) > 0
	})
}

func mustBigInt(s string) *big.Int {
	n, ok := new(big.Int).SetString(s, 10)
	if !ok {
		panic("invalid big int: " + s)
	}
	return n
}

// MatchPack picks the highest-priced pack whose price is <= value, and
// returns the resulting nonce (value - pack.priceWei). The smallest
// non-negative nonce across all packs corresponds to the highest matching
// pack — using a higher pack always yields a smaller diff. Cross-checked
// against the persisted intent's pack_id afterwards to catch ambiguity
// (e.g. someone paying small.priceWei + huge nonce that lands inside the
// medium range).
func MatchPack(value *big.Int) (string, *big.Int, bool) {
	for _, p := range packsByPriceDesc {
		if value.Cmp(p.PriceWei) >= 0 {
			return p.ID, new(big.Int).Sub(value, p.PriceWei), true
		}
	}
	return "", nil, false
}

func PackByID(id string) (Pack, bool) {
	for _, p := range Packs {
		if p.ID == id {
			return p, true
		}
	}
	return Pack{}, false
}
