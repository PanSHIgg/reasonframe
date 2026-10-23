package api

import (
	"context"
	"net/http"
	"sync"
	"time"
)

type readinessCheck struct {
	OK    bool   `json:"ok"`
	Error string `json:"error,omitempty"`
}

func (s *Server) health(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":              true,
		"service":         "reasonframe",
		"version":         s.Version,
		"modelConfigured": s.Config.ModelConfigured,
	})
}

func (s *Server) ready(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()
	checks := map[string]readinessCheck{
		"postgres": {OK: true},
		"redis":    {OK: true},
		"minio":    {OK: true},
		"ai":       {OK: true},
	}
	var mu sync.Mutex
	var wg sync.WaitGroup
	set := func(name string, err error) {
		mu.Lock()
		defer mu.Unlock()
		if err != nil {
			checks[name] = readinessCheck{OK: false, Error: err.Error()}
			return
		}
		checks[name] = readinessCheck{OK: true}
	}
	wg.Add(1)
	go func() {
		defer wg.Done()
		set("postgres", s.Store.Ping(ctx))
	}()
	wg.Add(1)
	go func() {
		defer wg.Done()
		if s.Queue == nil {
			set("redis", errString("queue is not configured"))
			return
		}
		set("redis", s.Queue.Ping(ctx))
	}()
	wg.Add(1)
	go func() {
		defer wg.Done()
		if s.Storage == nil {
			set("minio", errString("object storage is not configured"))
			return
		}
		set("minio", s.Storage.Ready(ctx))
	}()
	wg.Add(1)
	go func() {
		defer wg.Done()
		addresses := map[string]struct{}{}
		for _, addr := range []string{s.Config.AI.Author, s.Config.AI.Prepare, s.Config.AI.Render, s.Config.AI.Ingest} {
			if addr != "" {
				addresses[addr] = struct{}{}
			}
		}
		if len(addresses) == 0 {
			set("ai", errString("no AI addresses configured"))
			return
		}
		for addr := range addresses {
			health, err := s.AI.Health(ctx, addr)
			if err != nil {
				set("ai", err)
				return
			}
			if !health.Ok {
				set("ai", errString("AI health check reported not ready"))
				return
			}
		}
		set("ai", nil)
	}()
	wg.Wait()

	ok := true
	for _, check := range checks {
		if !check.OK {
			ok = false
			break
		}
	}
	status := http.StatusOK
	if !ok {
		status = http.StatusServiceUnavailable
	}
	writeJSON(w, status, map[string]any{"ok": ok, "service": "reasonframe", "checks": checks})
}

type errString string

func (e errString) Error() string { return string(e) }
