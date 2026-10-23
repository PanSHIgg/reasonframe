package queue

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/hibiken/asynq"
	"github.com/reasonframe/reasonframe/backend/internal/jobs"
	"github.com/redis/go-redis/v9"
)

type Queue struct {
	client    *asynq.Client
	inspector *asynq.Inspector
	rdb       *redis.Client
	opt       asynq.RedisClientOpt
	logger    *slog.Logger
	timeouts  jobs.TimeoutConfig
}

func RedisOptions(redisURL string) (asynq.RedisClientOpt, error) {
	u, err := url.Parse(redisURL)
	if err != nil {
		return asynq.RedisClientOpt{}, err
	}
	if u.Scheme != "redis" && u.Scheme != "rediss" {
		return asynq.RedisClientOpt{}, fmt.Errorf("redis URL must use redis:// or rediss://")
	}
	db := 0
	if path := strings.TrimPrefix(u.Path, "/"); path != "" {
		parsed, err := strconv.Atoi(path)
		if err != nil {
			return asynq.RedisClientOpt{}, fmt.Errorf("invalid redis database in URL")
		}
		db = parsed
	}
	opt := asynq.RedisClientOpt{Addr: u.Host, DB: db}
	if u.User != nil {
		opt.Username = u.User.Username()
		opt.Password, _ = u.User.Password()
	}
	if u.Scheme == "rediss" {
		opt.TLSConfig = &tls.Config{MinVersion: tls.VersionTLS12}
	}
	return opt, nil
}

func New(redisURL string, logger *slog.Logger) (*Queue, error) {
	opt, err := RedisOptions(redisURL)
	if err != nil {
		return nil, err
	}
	rdb, err := redis.ParseURL(redisURL)
	if err != nil {
		return nil, err
	}
	return &Queue{
		client:    asynq.NewClient(opt),
		inspector: asynq.NewInspector(opt),
		rdb:       redis.NewClient(rdb),
		opt:       opt,
		logger:    logger,
		timeouts:  jobs.DefaultTimeouts(),
	}, nil
}

func (q *Queue) SetTimeouts(timeouts jobs.TimeoutConfig) { q.timeouts = timeouts }

func (q *Queue) Close() error {
	var first error
	if err := q.client.Close(); err != nil {
		first = err
	}
	if err := q.inspector.Close(); err != nil && first == nil {
		first = err
	}
	if err := q.rdb.Close(); err != nil && first == nil {
		first = err
	}
	return first
}

func (q *Queue) RedisOpt() asynq.RedisClientOpt { return q.opt }

func (q *Queue) Ping(ctx context.Context) error { return q.rdb.Ping(ctx).Err() }

func (q *Queue) Enqueue(ctx context.Context, p Payload) error {
	if _, err := NewTask(p); err != nil {
		return err
	}
	if p.Traceparent == "" {
		p.Traceparent = newTraceparent()
	}
	task, err := NewTask(p)
	if err != nil {
		return err
	}
	timeout := p.Phase.Timeout(q.timeouts)
	options := []asynq.Option{
		asynq.Queue(p.Phase.Queue()),
		asynq.TaskID(p.TaskID()),
		asynq.Timeout(timeout),
		asynq.Deadline(time.Now().Add(24 * time.Hour)),
		asynq.MaxRetry(p.Phase.MaxRetry()),
		asynq.Retention(7 * 24 * time.Hour),
	}
	_, err = q.client.EnqueueContext(ctx, task, options...)
	if err != nil {
		if errors.Is(err, asynq.ErrTaskIDConflict) {
			return nil
		}
		return err
	}
	return nil
}

func (q *Queue) EnqueueJob(ctx context.Context, jobID string, kind jobs.TaskKind, attempt, autoRepairs int) error {
	return q.Enqueue(ctx, NewPayload(jobID, kind, attempt, autoRepairs))
}

func (q *Queue) DeleteJobTasks(ctx context.Context, jobID string, attempt, autoRepairs int) {
	kinds := []jobs.TaskKind{jobs.TaskAuthor, jobs.TaskPrepare, jobs.TaskRender, jobs.TaskIngest}
	for _, kind := range kinds {
		id := Payload{JobID: jobID, Phase: kind, Attempt: attempt, AutoRepairs: autoRepairs}.TaskID()
		if err := q.inspector.DeleteTask(kind.Queue(), id); err != nil && !errors.Is(err, asynq.ErrTaskNotFound) {
			q.logger.Warn("delete queued task failed", "job_id", jobID, "task_id", id, "error", err)
		}
	}
}

func (q *Queue) PublishCancel(ctx context.Context, jobID string) error {
	return q.rdb.Publish(ctx, "rf:cancel:"+jobID, "cancel").Err()
}

// SubscribeCancel returns a one-shot channel closed when a cancellation is
// published. The returned cleanup function must be called by the handler.
func (q *Queue) SubscribeCancel(ctx context.Context, jobID string) (<-chan struct{}, func()) {
	ch := make(chan struct{}, 1)
	pubsub := q.rdb.Subscribe(ctx, "rf:cancel:"+jobID)
	go func() {
		defer pubsub.Close()
		messages := pubsub.Channel()
		for {
			select {
			case <-ctx.Done():
				return
			case _, ok := <-messages:
				if !ok {
					return
				}
				select {
				case ch <- struct{}{}:
				default:
				}
				return
			}
		}
	}()
	return ch, func() { _ = pubsub.Close() }
}
