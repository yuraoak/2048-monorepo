package main

import (
	"context"
	"math/big"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/hexutil"
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
	if err := c.client.Client().CallContext(ctx, &block, "eth_getBlockByNumber",
		hexutil.EncodeUint64(blockNumber), true); err != nil {
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
	receipt, err := c.client.TransactionReceipt(ctx, common.HexToHash(txHash))
	if err != nil {
		return false, err
	}
	return receipt.Status == types.ReceiptStatusSuccessful, nil
}
