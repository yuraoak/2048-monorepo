package main

import (
	"context"
	"errors"
	"math/big"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Store struct {
	pool *pgxpool.Pool
}

func NewStore(ctx context.Context, dsn string) (*Store, error) {
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		return nil, err
	}
	return &Store{pool: pool}, nil
}

func (s *Store) Close() {
	s.pool.Close()
}

func (s *Store) GetCursor(ctx context.Context) (uint64, error) {
	var lastBlock int64
	err := s.pool.QueryRow(ctx,
		`SELECT last_block FROM reconciler_cursor WHERE id = 1`,
	).Scan(&lastBlock)
	if errors.Is(err, pgx.ErrNoRows) {
		// Migrations seed id=1, but be defensive: if the row was never
		// inserted, treat as a fresh cursor.
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	if lastBlock < 0 {
		return 0, nil
	}
	return uint64(lastBlock), nil
}

func (s *Store) SetCursor(ctx context.Context, block uint64) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO reconciler_cursor (id, last_block, updated_at)
		VALUES (1, $1, now())
		ON CONFLICT (id) DO UPDATE
		  SET last_block = EXCLUDED.last_block, updated_at = now()
	`, int64(block))
	return err
}

func (s *Store) PaymentExists(ctx context.Context, txHash string) (bool, error) {
	var exists bool
	err := s.pool.QueryRow(ctx,
		`SELECT EXISTS(SELECT 1 FROM undo_payments WHERE tx_hash = $1)`,
		txHash,
	).Scan(&exists)
	return exists, err
}

type Intent struct {
	FID    int64
	PackID string
}

// GetIntent looks up the persisted intent by nonce. Returns (nil, nil)
// when not found or when the nonce is too large to be a real intent
// (Redis INCR is monotonic from 1; persisted nonces fit in int64 by
// construction).
func (s *Store) GetIntent(ctx context.Context, nonce *big.Int) (*Intent, error) {
	if !nonce.IsInt64() || nonce.Sign() < 0 {
		return nil, nil
	}
	var fid int64
	var packID string
	err := s.pool.QueryRow(ctx,
		`SELECT fid, pack_id FROM pack_intents WHERE nonce = $1`,
		nonce.Int64(),
	).Scan(&fid, &packID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &Intent{FID: fid, PackID: packID}, nil
}

type PaymentRecord struct {
	TxHash      string
	FID         int64
	PackID      string
	Undos       int
	AmountWei   *big.Int
	BlockNumber uint64
}

// CreditPayment claims the tx in undo_payments and bumps undo_credits in
// a single transaction. Returns true when this call did the credit, false
// when the tx was already claimed (e.g. /api/shop/packs/buy raced us and
// won — it already credited, nothing more to do).
func (s *Store) CreditPayment(ctx context.Context, p PaymentRecord) (bool, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	res, err := tx.Exec(ctx, `
		INSERT INTO undo_payments (
		  tx_hash, fid, pack_id, undos_credited, amount_wei, block_number
		)
		VALUES ($1, $2, $3, $4, $5, $6)
		ON CONFLICT (tx_hash) DO NOTHING
	`, p.TxHash, p.FID, p.PackID, p.Undos, p.AmountWei.String(), int64(p.BlockNumber))
	if err != nil {
		return false, err
	}
	if res.RowsAffected() == 0 {
		return false, tx.Commit(ctx)
	}

	_, err = tx.Exec(ctx, `
		INSERT INTO undo_credits (fid, balance) VALUES ($1, $2)
		ON CONFLICT (fid) DO UPDATE
		  SET balance = undo_credits.balance + EXCLUDED.balance,
		      updated_at = now()
	`, p.FID, p.Undos)
	if err != nil {
		return false, err
	}

	return true, tx.Commit(ctx)
}
