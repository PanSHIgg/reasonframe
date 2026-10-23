package events

import (
	"context"
	"encoding/json"
	"log/slog"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type Hub struct {
	mu   sync.RWMutex
	subs map[uuid.UUID]map[chan struct{}]struct{}
}

func NewHub() *Hub {
	return &Hub{subs: map[uuid.UUID]map[chan struct{}]struct{}{}}
}

func (h *Hub) Subscribe(jobID uuid.UUID) (<-chan struct{}, func()) {
	ch := make(chan struct{}, 1)
	h.mu.Lock()
	if h.subs[jobID] == nil {
		h.subs[jobID] = map[chan struct{}]struct{}{}
	}
	h.subs[jobID][ch] = struct{}{}
	h.mu.Unlock()
	return ch, func() {
		h.mu.Lock()
		if set := h.subs[jobID]; set != nil {
			delete(set, ch)
			if len(set) == 0 {
				delete(h.subs, jobID)
			}
		}
		h.mu.Unlock()
	}
}

func (h *Hub) Notify(jobID uuid.UUID) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	for ch := range h.subs[jobID] {
		select {
		case ch <- struct{}{}:
		default:
		}
	}
}

// Broadcast tells every SSE connection to catch up from PostgreSQL. It is
// used after the LISTEN connection reconnects.
func (h *Hub) Broadcast() {
	h.mu.RLock()
	defer h.mu.RUnlock()
	for _, set := range h.subs {
		for ch := range set {
			select {
			case ch <- struct{}{}:
			default:
			}
		}
	}
}

type Listener struct {
	DSN    string
	Hub    *Hub
	Logger *slog.Logger
}

type notification struct {
	JobID string `json:"jobId"`
	ID    int64  `json:"id"`
}

func (l *Listener) Run(ctx context.Context) {
	backoff := time.Second
	for ctx.Err() == nil {
		conn, err := pgx.Connect(ctx, l.DSN)
		if err != nil {
			l.Logger.Warn("pg LISTEN connect failed", "error", err)
			if !sleep(ctx, backoff) {
				return
			}
			backoff = nextBackoff(backoff)
			continue
		}
		_, err = conn.Exec(ctx, "LISTEN job_events")
		if err != nil {
			l.Logger.Warn("pg LISTEN failed", "error", err)
			_ = conn.Close(context.Background())
			if !sleep(ctx, backoff) {
				return
			}
			backoff = nextBackoff(backoff)
			continue
		}
		backoff = time.Second
		l.Hub.Broadcast()
		for {
			raw, err := conn.WaitForNotification(ctx)
			if err != nil {
				if ctx.Err() != nil {
					_ = conn.Close(context.Background())
					return
				}
				l.Logger.Warn("pg LISTEN connection lost", "error", err)
				break
			}
			var note notification
			if err := json.Unmarshal([]byte(raw.Payload), &note); err != nil {
				continue
			}
			jobID, err := uuid.Parse(note.JobID)
			if err != nil {
				continue
			}
			l.Hub.Notify(jobID)
		}
		_ = conn.Close(context.Background())
		if !sleep(ctx, backoff) {
			return
		}
		backoff = nextBackoff(backoff)
	}
}

func nextBackoff(current time.Duration) time.Duration {
	next := current * 2
	if next > 30*time.Second {
		return 30 * time.Second
	}
	return next
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
