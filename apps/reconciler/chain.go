package main

import (
	"context"
	"math/big"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/hexutil"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/ethclient"
)

// isTransient reports whether an RPC error is worth retrying. The public Base
// node rate-limits (429) and intermittently 503s under load; those are
// transient, unlike a malformed request or a missing block.
func isTransient(err error) bool {
	if err == nil {
		return false
	}
	s := err.Error()
	for _, m := range []string{
		"429", "Too Many Requests", "over rate limit",
		"503", "502", "timeout", "EOF", "connection reset",
	} {
		if strings.Contains(s, m) {
			return true
		}
	}
	return false
}

// retryRPC runs fn with exponential backoff on transient errors. Bounded so a
// genuinely-down RPC still surfaces an error and fails the tick (which then
// retries from the cursor next interval) rather than blocking forever.
func retryRPC(ctx context.Context, fn func() error) error {
	backoff := 250 * time.Millisecond
	var err error
	for attempt := 0; attempt < 6; attempt++ {
		if err = fn(); err == nil || !isTransient(err) {
			return err
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(backoff):
		}
		backoff *= 2
	}
	return err
}

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
	var head uint64
	err := retryRPC(ctx, func() error {
		var e error
		head, e = c.client.BlockNumber(ctx)
		return e
	})
	return head, err
}

type TreasuryTx struct {
	Hash        string
	Value       *big.Int
	BlockNumber uint64
}

type rpcTx struct {
	Hash  string          `json:"hash"`
	To    *common.Address `json:"to"`
	Value *hexutil.Big    `json:"value"`
	Type  hexutil.Uint64  `json:"type"`
}

type rpcBlock struct {
	Transactions []rpcTx `json:"transactions"`
}

// OP Stack deposit transaction type — system tx present in every Base block.
// Standard go-ethereum can't RLP-decode it, which is why we go through raw
// JSON-RPC instead of ethclient.BlockByNumber.
const opDepositTxType = 0x7e

// ScanBlock returns every transaction in the block whose recipient is the
// treasury and whose value is positive. Status check (revert vs success)
// is deferred to the per-tx fetch in processTx — most blocks have zero
// matches and we don't want to pay receipt cost for blocks that don't
// concern us.
func (c *Chain) ScanBlock(ctx context.Context, blockNumber uint64) ([]TreasuryTx, error) {
	var block rpcBlock
	if err := retryRPC(ctx, func() error {
		return c.client.Client().CallContext(ctx, &block, "eth_getBlockByNumber",
			hexutil.EncodeUint64(blockNumber), true)
	}); err != nil {
		return nil, err
	}
	var out []TreasuryTx
	for _, tx := range block.Transactions {
		if tx.Type == opDepositTxType {
			continue
		}
		if tx.To == nil || *tx.To != c.treasury {
			continue
		}
		value := (*big.Int)(tx.Value)
		if value == nil || value.Sign() <= 0 {
			continue
		}
		out = append(out, TreasuryTx{
			Hash:        tx.Hash,
			Value:       new(big.Int).Set(value),
			BlockNumber: blockNumber,
		})
	}
	return out, nil
}

func (c *Chain) TxSucceeded(ctx context.Context, txHash string) (bool, error) {
	var receipt *types.Receipt
	err := retryRPC(ctx, func() error {
		var e error
		receipt, e = c.client.TransactionReceipt(ctx, common.HexToHash(txHash))
		return e
	})
	if err != nil {
		return false, err
	}
	return receipt.Status == types.ReceiptStatusSuccessful, nil
}
