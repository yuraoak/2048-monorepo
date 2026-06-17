package main

import (
	"errors"
	"os"
	"strconv"
	"time"
)

type Config struct {
	DatabaseURL      string
	BaseRPCURL       string
	TreasuryAddress  string
	MinConfirmations uint64
	PollInterval     time.Duration
	MaxBlocksPerTick uint64
	InitialLookback  uint64
	ScanConcurrency  uint64
}

func LoadConfig() (Config, error) {
	cfg := Config{
		DatabaseURL:      os.Getenv("DATABASE_URL"),
		BaseRPCURL:       getEnv("BASE_RPC_URL", "https://mainnet.base.org"),
		TreasuryAddress:  os.Getenv("TREASURY_ADDRESS"),
		MinConfirmations: parseUint("UNDO_MIN_CONFIRMATIONS", 1),
		PollInterval:     parseDuration("RECONCILER_INTERVAL", 60*time.Second),
		MaxBlocksPerTick: parseUint("RECONCILER_MAX_BLOCKS_PER_TICK", 2000),
		InitialLookback:  parseUint("RECONCILER_INITIAL_LOOKBACK", 50_000),
		ScanConcurrency:  parseUint("RECONCILER_SCAN_CONCURRENCY", 16),
	}
	if cfg.DatabaseURL == "" {
		return cfg, errors.New("DATABASE_URL required")
	}
	if cfg.TreasuryAddress == "" {
		return cfg, errors.New("TREASURY_ADDRESS required")
	}
	return cfg, nil
}

func getEnv(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func parseUint(k string, def uint64) uint64 {
	v := os.Getenv(k)
	if v == "" {
		return def
	}
	n, err := strconv.ParseUint(v, 10, 64)
	if err != nil {
		return def
	}
	return n
}

func parseDuration(k string, def time.Duration) time.Duration {
	v := os.Getenv(k)
	if v == "" {
		return def
	}
	d, err := time.ParseDuration(v)
	if err != nil {
		return def
	}
	return d
}
