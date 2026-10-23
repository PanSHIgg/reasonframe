package worker

import (
	"context"
	"fmt"
	"log/slog"
	"math"
	"sync"
	"time"

	"github.com/hibiken/asynq"
	"github.com/reasonframe/reasonframe/backend/internal/config"
	"github.com/reasonframe/reasonframe/backend/internal/jobs"
	"github.com/reasonframe/reasonframe/backend/internal/queue"
)

func Run(ctx context.Context, cfg config.Config, handler *Handler, logger *slog.Logger, queues []string) error {
	opt, err := queue.RedisOptions(cfg.RedisURL)
	if err != nil {
		return err
	}
	mux := asynq.NewServeMux()
	for _, kind := range []jobs.TaskKind{jobs.TaskAuthor, jobs.TaskPrepare, jobs.TaskRender, jobs.TaskIngest} {
		kind := kind
		mux.HandleFunc(queue.TaskType(kind), handler.Handle)
	}

	specs := []struct {
		name        string
		concurrency int
	}{
		{"author", cfg.WorkerConcurrencyAuthor},
		{"prepare", cfg.WorkerConcurrencyPrepare},
		{"render", cfg.WorkerConcurrencyRender},
	}
	selected := make(map[string]bool, len(queues))
	for _, queue := range queues {
		selected[queue] = true
	}
	servers := make([]*asynq.Server, 0, len(specs))
	for _, spec := range specs {
		if !selected[spec.name] {
			continue
		}
		server := asynq.NewServer(opt, asynq.Config{
			Concurrency:     spec.concurrency,
			Queues:          map[string]int{spec.name: 1},
			ShutdownTimeout: cfg.ShutdownTimeout,
			LogLevel:        asynq.WarnLevel,
			RetryDelayFunc:  retryDelay,
			ErrorHandler:    handler,
		})
		if err := server.Start(mux); err != nil {
			for _, started := range servers {
				started.Shutdown()
			}
			return fmt.Errorf("start %s worker: %w", spec.name, err)
		}
		logger.Info("worker started", "queue", spec.name, "concurrency", spec.concurrency)
		servers = append(servers, server)
	}
	if len(servers) == 0 {
		return fmt.Errorf("no worker queues selected")
	}
	<-ctx.Done()
	var wg sync.WaitGroup
	for _, server := range servers {
		wg.Add(1)
		go func(server *asynq.Server) {
			defer wg.Done()
			server.Shutdown()
		}(server)
	}
	wg.Wait()
	return nil
}

func retryDelay(retryCount int, _ error, _ *asynq.Task) time.Duration {
	seconds := math.Pow(2, float64(retryCount-1))
	if seconds < 1 {
		seconds = 1
	}
	delay := time.Duration(seconds) * 5 * time.Second
	if delay > 5*time.Minute {
		delay = 5 * time.Minute
	}
	return delay
}
