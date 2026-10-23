package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"runtime/debug"
	"strings"
	"syscall"
	"time"

	"github.com/reasonframe/reasonframe/backend/internal/ai"
	"github.com/reasonframe/reasonframe/backend/internal/api"
	"github.com/reasonframe/reasonframe/backend/internal/auth"
	"github.com/reasonframe/reasonframe/backend/internal/config"
	"github.com/reasonframe/reasonframe/backend/internal/events"
	"github.com/reasonframe/reasonframe/backend/internal/queue"
	"github.com/reasonframe/reasonframe/backend/internal/reconciler"
	"github.com/reasonframe/reasonframe/backend/internal/storage"
	"github.com/reasonframe/reasonframe/backend/internal/store"
	"github.com/reasonframe/reasonframe/backend/internal/worker"
	"github.com/reasonframe/reasonframe/backend/migrations"
)

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: rf api|worker|reconciler|migrate")
		os.Exit(2)
	}
	role := config.Role(strings.TrimSpace(os.Args[1]))
	switch role {
	case config.RoleAPI, config.RoleWorker, config.RoleReconciler, config.RoleMigrate:
	default:
		fmt.Fprintf(os.Stderr, "unknown command %q (want api, worker, reconciler, or migrate)\n", role)
		os.Exit(2)
	}
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: logLevel()}))
	slog.SetDefault(logger)
	cfg, err := config.Load()
	if err == nil {
		err = cfg.Validate(role)
	}
	if err != nil {
		logger.Error("invalid configuration", "error", err)
		os.Exit(2)
	}
	queues := []string{"author", "prepare", "render"}
	if role == config.RoleWorker {
		fs := flag.NewFlagSet("worker", flag.ContinueOnError)
		raw := fs.String("queues", "author,prepare,render", "comma-separated queues: author,prepare,render")
		if err := fs.Parse(os.Args[2:]); err != nil {
			logger.Error("invalid worker flags", "error", err)
			os.Exit(2)
		}
		if queues, err = parseQueues(*raw); err != nil {
			logger.Error("invalid worker queues", "error", err)
			os.Exit(2)
		}
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	if err := run(ctx, role, cfg, logger, queues); err != nil {
		logger.Error("command failed", "command", role, "error", err)
		os.Exit(1)
	}
}

func run(ctx context.Context, role config.Role, cfg config.Config, logger *slog.Logger, queues []string) error {
	st, err := store.Open(ctx, cfg.DatabaseURL)
	if err != nil {
		return fmt.Errorf("open database: %w", err)
	}
	defer st.Close()

	if role == config.RoleMigrate {
		if err := st.Migrate(ctx, migrations.FS); err != nil {
			return fmt.Errorf("migrate: %w", err)
		}
		accountID, err := st.EnsureDefaultAccount(ctx)
		if err != nil {
			return err
		}
		logger.Info("migrations applied", "default_account_id", accountID.String())
		return nil
	}

	q, err := queue.New(cfg.RedisURL, logger)
	if err != nil {
		return fmt.Errorf("open queue: %w", err)
	}
	q.SetTimeouts(cfg.TaskTimeouts)
	defer q.Close()

	switch role {
	case config.RoleAPI:
		return runAPI(ctx, cfg, logger, st, q)
	case config.RoleWorker:
		return runWorker(ctx, cfg, logger, st, q, queues)
	case config.RoleReconciler:
		return runReconciler(ctx, cfg, logger, st, q)
	default:
		return fmt.Errorf("unsupported command %q", role)
	}
}

func runAPI(ctx context.Context, cfg config.Config, logger *slog.Logger, st *store.Store, q *queue.Queue) error {
	accountID, err := st.EnsureDefaultAccount(ctx)
	if err != nil {
		return err
	}
	blob, err := storage.New(cfg.S3)
	if err != nil {
		return fmt.Errorf("open object storage: %w", err)
	}
	aiManager, err := ai.NewManager(uniqueAddrs(cfg.AI.Author, cfg.AI.Prepare, cfg.AI.Render, cfg.AI.Ingest), cfg.AI.InternalToken)
	if err != nil {
		return err
	}
	defer aiManager.Close()
	hub := events.NewHub()
	listener := &events.Listener{DSN: cfg.DatabaseURL, Hub: hub, Logger: logger}
	go listener.Run(ctx)
	authenticator := auth.New(cfg, st, accountID, logger)
	handler := api.New(api.Deps{
		Config: cfg, Store: st, Storage: blob, Queue: q, AI: aiManager,
		Hub: hub, Auth: authenticator, Logger: logger, Version: buildVersion(),
	})
	server := &http.Server{
		Addr:              cfg.HTTPAddr,
		Handler:           handler,
		ReadHeaderTimeout: 15 * time.Second,
		IdleTimeout:       120 * time.Second,
	}
	errCh := make(chan error, 1)
	go func() {
		logger.Info("api listening", "addr", cfg.HTTPAddr, "auth_mode", cfg.Auth.Mode)
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
		}
		close(errCh)
	}()
	select {
	case <-ctx.Done():
	case err := <-errCh:
		if err != nil {
			return err
		}
	}
	shutdownCtx, cancel := context.WithTimeout(context.Background(), cfg.ShutdownTimeout)
	defer cancel()
	if err := server.Shutdown(shutdownCtx); err != nil {
		logger.Warn("api shutdown did not finish cleanly", "error", err)
	}
	return nil
}

func runWorker(ctx context.Context, cfg config.Config, logger *slog.Logger, st *store.Store, q *queue.Queue, queues []string) error {
	aiManager, err := ai.NewManager(uniqueAddrs(cfg.AI.Author, cfg.AI.Prepare, cfg.AI.Render, cfg.AI.Ingest), cfg.AI.InternalToken)
	if err != nil {
		return err
	}
	defer aiManager.Close()
	hostname, _ := os.Hostname()
	handler := &worker.Handler{
		Store: st, Queue: q, AI: aiManager, Config: cfg, Logger: logger,
		WorkerID: fmt.Sprintf("%s-%d", hostname, os.Getpid()),
	}
	return worker.Run(ctx, cfg, handler, logger, queues)
}

func parseQueues(value string) ([]string, error) {
	allowed := map[string]bool{"author": true, "prepare": true, "render": true}
	seen := map[string]bool{}
	queues := make([]string, 0, 3)
	for _, part := range strings.Split(value, ",") {
		name := strings.TrimSpace(part)
		if name == "" {
			continue
		}
		if !allowed[name] {
			return nil, fmt.Errorf("unknown queue %q (want author, prepare, render)", name)
		}
		if seen[name] {
			continue
		}
		seen[name] = true
		queues = append(queues, name)
	}
	if len(queues) == 0 {
		return nil, errors.New("at least one worker queue is required")
	}
	return queues, nil
}

func runReconciler(ctx context.Context, cfg config.Config, logger *slog.Logger, st *store.Store, q *queue.Queue) error {
	var blob *storage.Client
	if cfg.S3.Endpoint != "" && cfg.S3.Bucket != "" && cfg.S3.AccessKey != "" {
		var err error
		blob, err = storage.New(cfg.S3)
		if err != nil {
			return fmt.Errorf("open object storage: %w", err)
		}
	}
	r := &reconciler.Reconciler{Store: st, Queue: q, Storage: blob, Interval: cfg.ReconcileInterval, Logger: logger}
	return r.Run(ctx)
}

func uniqueAddrs(values ...string) []string {
	seen := map[string]struct{}{}
	out := make([]string, 0, len(values))
	for _, value := range values {
		if value == "" {
			continue
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		out = append(out, value)
	}
	return out
}

func logLevel() slog.Level {
	switch strings.ToLower(strings.TrimSpace(os.Getenv("LOG_LEVEL"))) {
	case "debug":
		return slog.LevelDebug
	case "warn", "warning":
		return slog.LevelWarn
	case "error":
		return slog.LevelError
	default:
		return slog.LevelInfo
	}
}

func buildVersion() string {
	if info, ok := debug.ReadBuildInfo(); ok && info.Main.Version != "" && info.Main.Version != "(devel)" {
		return info.Main.Version
	}
	return "dev"
}
