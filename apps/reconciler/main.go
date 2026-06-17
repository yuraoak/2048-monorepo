package main

import (
	"context"
	"log/slog"
	"net/url"
	"os"
	"os/signal"
	"syscall"
	"time"
)

// redactRPC strips the path/query from an RPC URL so API keys (e.g. Alchemy's
// /v2/<key>) never land in logs. Returns scheme://host.
func redactRPC(raw string) string {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return "<rpc>"
	}
	return u.Scheme + "://" + u.Host
}

func main() {
	slog.SetDefault(slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	})))

	cfg, err := LoadConfig()
	if err != nil {
		slog.Error("config", "err", err)
		os.Exit(1)
	}

	ctx, stop := signal.NotifyContext(context.Background(),
		syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	store, err := NewStore(ctx, cfg.DatabaseURL)
	if err != nil {
		slog.Error("db connect", "err", err)
		os.Exit(1)
	}
	defer store.Close()

	chain, err := NewChain(ctx, cfg.BaseRPCURL, cfg.TreasuryAddress)
	if err != nil {
		slog.Error("rpc connect", "err", err)
		os.Exit(1)
	}
	defer chain.Close()

	r := &Reconciler{
		store:            store,
		chain:            chain,
		minConfirmations: cfg.MinConfirmations,
		maxBlocksPerTick: cfg.MaxBlocksPerTick,
		initialLookback:  cfg.InitialLookback,
		scanConcurrency:  cfg.ScanConcurrency,
	}

	slog.Info("reconciler started",
		"rpc", redactRPC(cfg.BaseRPCURL),
		"treasury", cfg.TreasuryAddress,
		"interval", cfg.PollInterval.String(),
		"max_blocks_per_tick", cfg.MaxBlocksPerTick,
		"scan_concurrency", cfg.ScanConcurrency,
		"min_confirmations", cfg.MinConfirmations,
	)

	runTick(ctx, r)

	ticker := time.NewTicker(cfg.PollInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			slog.Info("shutting down")
			return
		case <-ticker.C:
			runTick(ctx, r)
		}
	}
}

func runTick(ctx context.Context, r *Reconciler) {
	tickCtx, cancel := context.WithTimeout(ctx, 5*time.Minute)
	defer cancel()
	if err := r.Tick(tickCtx); err != nil {
		slog.Error("tick failed", "err", err)
	}
}
