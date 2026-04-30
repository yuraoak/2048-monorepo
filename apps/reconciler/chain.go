package main

import (
	"context"
	"math/big"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/ethclient"
)

type Chain struct {
	client   *ethclient.Client
	treasury common.Address
}

func NewChain(ctx context.Context, rpcURL, treasury string) (*Chain, error) {
	c, err := ethclient.DialContext(ctx, rpcURL)
	if err != nil {
		return nil, err
	}
	return &Chain{
		client:   c,
		treasury: common.HexToAddress(treasury),
	}, nil
}

func (c *Chain) Close() {
	c.client.Close()
}

func (c *Chain) HeadBlock(ctx context.Context) (uint64, error) {
	return c.client.BlockNumber(ctx)
}

type TreasuryTx struct {
	Hash        string
	Value       *big.Int
	BlockNumber uint64
}

// ScanBlock returns every transaction in the block whose recipient is the
// treasury and whose value is positive. Status check (revert vs success)
// is deferred to the per-tx fetch in processTx — most blocks have zero
// matches and we don't want to pay receipt cost for blocks that don't
// concern us.
func (c *Chain) ScanBlock(ctx context.Context, blockNumber uint64) ([]TreasuryTx, error) {
	block, err := c.client.BlockByNumber(ctx, new(big.Int).SetUint64(blockNumber))
	if err != nil {
		return nil, err
	}
	var out []TreasuryTx
	for _, tx := range block.Transactions() {
		to := tx.To()
		if to == nil || *to != c.treasury {
			continue
		}
		value := tx.Value()
		if value.Sign() <= 0 {
			continue
		}
		out = append(out, TreasuryTx{
			Hash:        tx.Hash().Hex(),
			Value:       new(big.Int).Set(value),
			BlockNumber: blockNumber,
		})
	}
	return out, nil
}

func (c *Chain) TxSucceeded(ctx context.Context, txHash string) (bool, error) {
	receipt, err := c.client.TransactionReceipt(ctx, common.HexToHash(txHash))
	if err != nil {
		return false, err
	}
	return receipt.Status == types.ReceiptStatusSuccessful, nil
}
