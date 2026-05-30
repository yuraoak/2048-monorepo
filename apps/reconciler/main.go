package main

import (
	"context"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

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
	}

	slog.Info("reconciler started",
		"rpc", cfg.BaseRPCURL,
		"treasury", cfg.TreasuryAddress,
		"interval", cfg.PollInterval.String(),
		"max_blocks_per_tick", cfg.MaxBlocksPerTick,
		"min_confirmations", cfg.MinConfirmations,
	)

	// Minimal HTTP listener so PaaS healthchecks pass. The worker has no real
	// HTTP surface, but Lizard's deploy gate waits for $PORT to bind.
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	go func() {
		mux := http.NewServeMux()
		mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusOK)
		})
		mux.HandleFunc("/", func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusOK)
		})
		if err := http.ListenAndServe(":"+port, mux); err != nil {
			slog.Error("healthz listener", "err", err)
		}
	}()

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
