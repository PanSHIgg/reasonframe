package reconciler

import (
	"context"
	"log/slog"
	"time"

	"github.com/reasonframe/reasonframe/backend/internal/jobs"
	"github.com/reasonframe/reasonframe/backend/internal/queue"
	"github.com/reasonframe/reasonframe/backend/internal/storage"
	"github.com/reasonframe/reasonframe/backend/internal/store"
)

const advisoryLockKey = int64(0x7265667265636f) // "refreco"

type Reconciler struct {
	Store    *store.Store
	Queue    *queue.Queue
	Storage  *storage.Client
	Interval time.Duration
	Logger   *slog.Logger
}

func (r *Reconciler) Run(ctx context.Context) error {
	for ctx.Err() == nil {
		conn, err := r.Store.Pool().Acquire(ctx)
		if err != nil {
			return err
		}
		var locked bool
		if err := conn.QueryRow(ctx, "SELECT pg_try_advisory_lock($1)", advisoryLockKey).Scan(&locked); err != nil {
			conn.Release()
			return err
		}
		if !locked {
			r.Logger.Info("another reconciler holds the advisory lock; standing by")
			conn.Release()
			if !sleep(ctx, r.Interval) {
				return nil
			}
			continue
		}
		r.Logger.Info("reconciler acquired advisory lock")
		r.loop(ctx)
		_, _ = conn.Exec(context.Background(), "SELECT pg_advisory_unlock($1)", advisoryLockKey)
		conn.Release()
	}
	return nil
}

func (r *Reconciler) loop(ctx context.Context) {
	ticker := time.NewTicker(r.Interval)
	defer ticker.Stop()
	for {
		r.tick(ctx)
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (r *Reconciler) tick(ctx context.Context) {
	runCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	if count, err := r.Store.ReapStaleRuns(runCtx, 300); err != nil {
		r.Logger.Warn("reap stale runs failed", "error", err)
	} else if count > 0 {
		r.Logger.Info("reaped stale job runs", "count", count)
	}
	queued, err := r.Store.ListStaleQueued(runCtx, 60*time.Second, 100)
	if err != nil {
		r.Logger.Warn("list stale queued jobs failed", "error", err)
	}
	for i := range queued {
		job := &queued[i]
		kind := jobs.QueuedKind(job.Phase, job.Input, job.Checkpoint)
		if kind == "" {
			continue
		}
		if err := r.Queue.EnqueueJob(runCtx, job.ID.String(), kind, job.Attempt, job.AutoRepairs); err != nil {
			r.Logger.Warn("re-enqueue stale job failed", "job_id", job.ID.String(), "phase", kind, "error", err)
		} else {
			r.Logger.Info("re-enqueued stale job", "job_id", job.ID.String(), "phase", kind)
		}
	}
	running, err := r.Store.ListExpiredRunning(runCtx, 100)
	if err != nil {
		r.Logger.Warn("list expired running jobs failed", "error", err)
	}
	for i := range running {
		job := &running[i]
		ok, err := r.Store.MarkInterrupted(runCtx, job)
		if err != nil {
			r.Logger.Warn("mark interrupted failed", "job_id", job.ID.String(), "error", err)
		} else if ok {
			r.Logger.Info("marked job interrupted", "job_id", job.ID.String())
			if err := r.Queue.PublishCancel(runCtx, job.ID.String()); err != nil {
				r.Logger.Warn("publish interruption signal failed", "job_id", job.ID.String(), "error", err)
			}
		}
	}
	keys, err := r.Store.DeleteExpiredUploads(runCtx)
	if err != nil {
		r.Logger.Warn("cleanup expired uploads failed", "error", err)
	}
	if r.Storage != nil {
		for _, key := range keys {
			if err := r.Storage.Remove(runCtx, key); err != nil {
				r.Logger.Warn("remove expired upload object failed", "object_key", key, "error", err)
			}
		}
	}
}

func sleep(ctx context.Context, d time.Duration) bool {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}
