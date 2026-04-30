package main

import (
	"context"
	"log/slog"
	"strings"
)

type Reconciler struct {
	store            *Store
	chain            *Chain
	minConfirmations uint64
	maxBlocksPerTick uint64
	initialLookback  uint64
}

func (r *Reconciler) Tick(ctx context.Context) error {
	head, err := r.chain.HeadBlock(ctx)
	if err != nil {
		return err
	}
	if head < r.minConfirmations {
		return nil
	}
	safeHead := head - r.minConfirmations

	cursor, err := r.store.GetCursor(ctx)
	if err != nil {
		return err
	}

	var from uint64
	if cursor == 0 {
		// First run: don't replay all of Base. Start `initialLookback`
		// blocks back so we still catch payments from the last few hours
		// of activity.
		if safeHead > r.initialLookback {
			from = safeHead - r.initialLookback + 1
		} else {
			from = 1
		}
	} else {
		from = cursor + 1
	}

	if from > safeHead {
		return nil
	}

	to := safeHead
	if to-from+1 > r.maxBlocksPerTick {
		to = from + r.maxBlocksPerTick - 1
	}

	slog.Info("scanning blocks", "from", from, "to", to, "head", head)

	for block := from; block <= to; block++ {
		if err := r.scanBlock(ctx, block); err != nil {
			// Don't advance the cursor past a block we couldn't fully
			// process. Better to retry on the next tick than to silently
			// skip a block on a transient RPC error.
			return err
		}
		if err := r.store.SetCursor(ctx, block); err != nil {
			return err
		}
	}
	return nil
}

func (r *Reconciler) scanBlock(ctx context.Context, block uint64) error {
	txs, err := r.chain.ScanBlock(ctx, block)
	if err != nil {
		return err
	}
	for _, tx := range txs {
		if err := r.processTx(ctx, tx); err != nil {
			return err
		}
	}
	return nil
}

func (r *Reconciler) processTx(ctx context.Context, tx TreasuryTx) error {
	txHash := strings.ToLower(tx.Hash)

	exists, err := r.store.PaymentExists(ctx, txHash)
	if err != nil {
		return err
	}
	if exists {
		// Already credited (typically by /api/shop/packs/buy).
		return nil
	}

	ok, err := r.chain.TxSucceeded(ctx, txHash)
	if err != nil {
		return err
	}
	if !ok {
		slog.Info("treasury tx reverted; ignoring", "tx", txHash)
		return nil
	}

	packID, nonce, matched := MatchPack(tx.Value)
	if !matched {
		// Below the smallest pack price — not a pack purchase. Could be
		// a stray donation; nothing to credit.
		slog.Warn("treasury payment below smallest pack price",
			"tx", txHash, "value", tx.Value.String())
		return nil
	}

	intent, err := r.store.GetIntent(ctx, nonce)
	if err != nil {
		return err
	}
	if intent == nil {
		// Either Redis-only intent that expired before we wrote to
		// Postgres, an attacker probing values, or someone sending ETH
		// directly to treasury. Log for operator review; never auto-credit
		// without an intent — there's no way to know which fid to credit.
		slog.Warn("orphan treasury payment without persisted intent",
			"tx", txHash,
			"value", tx.Value.String(),
			"matched_pack", packID,
			"nonce", nonce.String())
		return nil
	}
	if intent.PackID != packID {
		// Value falls in a different pack's nonce range than the user
		// requested. This shouldn't happen via the legit client (pack +
		// price are paired in the intent response) but guard against
		// crediting the wrong pack regardless.
		slog.Warn("intent pack mismatch — refusing to credit",
			"tx", txHash,
			"intent_pack", intent.PackID,
			"matched_pack", packID,
			"fid", intent.FID,
			"nonce", nonce.String())
		return nil
	}

	pack, ok := PackByID(packID)
	if !ok {
		return nil
	}

	credited, err := r.store.CreditPayment(ctx, PaymentRecord{
		TxHash:      txHash,
		FID:         intent.FID,
		PackID:      packID,
		Undos:       pack.Undos,
		AmountWei:   tx.Value,
		BlockNumber: tx.BlockNumber,
	})
	if err != nil {
		return err
	}
	if credited {
		slog.Info("reconciled orphan payment",
			"tx", txHash,
			"fid", intent.FID,
			"pack", packID,
			"undos", pack.Undos)
	}
	return nil
}
