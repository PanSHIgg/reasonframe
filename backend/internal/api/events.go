package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"time"

	"github.com/reasonframe/reasonframe/backend/internal/store"
)

type sseEvent struct {
	ID    int64           `json:"id"`
	JobID string          `json:"jobId"`
	Time  time.Time       `json:"time"`
	Type  string          `json:"type"`
	Stage string          `json:"stage,omitempty"`
	Data  json.RawMessage `json:"data"`
}

func (s *Server) streamEvents(w http.ResponseWriter, r *http.Request) {
	principal, ok := principalOf(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Valid service bearer token required")
		return
	}
	jobID, err := parseJobID(r)
	if err != nil {
		s.writeMappedError(w, r, err)
		return
	}
	if _, err := s.Store.GetJobForAccount(r.Context(), principal.AccountID, jobID); err != nil {
		s.writeMappedError(w, r, err)
		return
	}
	after := int64(0)
	rawAfter := r.Header.Get("Last-Event-ID")
	if rawAfter == "" {
		rawAfter = r.URL.Query().Get("after")
	}
	if rawAfter != "" {
		parsed, err := strconv.ParseInt(rawAfter, 10, 64)
		if err != nil || parsed < 0 {
			s.writeMappedError(w, r, badInput("after/Last-Event-ID must be a nonnegative integer"))
			return
		}
		after = parsed
	}

	flusher, _ := w.(http.Flusher)
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	if flusher != nil {
		flusher.Flush()
	}

	notify, unsubscribe := s.Hub.Subscribe(jobID)
	defer unsubscribe()

	last := after
	send := func(event store.Event) bool {
		if event.ID <= last {
			return true
		}
		last = event.ID
		payload, err := json.Marshal(sseEvent{
			ID: event.ID, JobID: event.JobID.String(), Time: event.CreatedAt,
			Type: event.Type, Stage: event.Stage, Data: event.Data,
		})
		if err != nil {
			return true
		}
		if _, err := fmt.Fprintf(w, "id: %d\nevent: %s\ndata: %s\n\n", event.ID, event.Type, payload); err != nil {
			return false
		}
		if flusher != nil {
			flusher.Flush()
		}
		return true
	}
	drain := func() bool {
		for {
			events, err := s.Store.ListEvents(r.Context(), principal.AccountID, jobID, last, 1000)
			if err != nil {
				s.Logger.Warn("SSE replay query failed", "job_id", jobID.String(), "error", err)
				return true
			}
			for _, event := range events {
				if !send(event) {
					return false
				}
			}
			if len(events) < 1000 {
				return true
			}
		}
	}
	if !drain() {
		return
	}

	heartbeat := time.NewTicker(15 * time.Second)
	defer heartbeat.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-notify:
			if !drain() {
				return
			}
		case <-heartbeat.C:
			if _, err := fmt.Fprint(w, ": heartbeat\n\n"); err != nil {
				return
			}
			if flusher != nil {
				flusher.Flush()
			}
		}
	}
}
