package api

import (
	"log/slog"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	openapispec "github.com/reasonframe/reasonframe/backend/api"
	"github.com/reasonframe/reasonframe/backend/internal/ai"
	"github.com/reasonframe/reasonframe/backend/internal/auth"
	"github.com/reasonframe/reasonframe/backend/internal/config"
	"github.com/reasonframe/reasonframe/backend/internal/events"
	"github.com/reasonframe/reasonframe/backend/internal/queue"
	"github.com/reasonframe/reasonframe/backend/internal/storage"
	"github.com/reasonframe/reasonframe/backend/internal/store"
)

type Deps struct {
	Config  config.Config
	Store   *store.Store
	Storage *storage.Client
	Queue   *queue.Queue
	AI      *ai.Manager
	Hub     *events.Hub
	Auth    *auth.Authenticator
	Logger  *slog.Logger
	Version string
}

type Server struct {
	Deps
	startedAt   time.Time
	openapiJSON []byte
	openapiErr  error
}

func New(deps Deps) http.Handler {
	s := &Server{Deps: deps, startedAt: time.Now().UTC()}
	s.openapiJSON, s.openapiErr = openapispec.JSON()
	r := chi.NewRouter()
	r.Use(middleware.RequestID)
	r.Use(middleware.RealIP)
	r.Use(s.recoverer)
	r.Use(securityHeaders)

	r.Get("/health", s.health)
	r.Get("/health/ready", s.ready)

	r.Group(func(r chi.Router) {
		r.Use(deps.Auth.Middleware)
		r.Get("/openapi.json", s.openapi)
		r.Route("/v1", func(r chi.Router) {
			r.Get("/config", s.getConfig)
			r.Get("/jobs", s.listJobs)
			r.Post("/jobs", s.createJob)
			r.Get("/jobs/{id}", s.getJob)
			r.Post("/jobs/{id}/cancel", s.cancelJob)
			r.Post("/jobs/{id}/retry", s.retryJob)
			r.Post("/jobs/{id}/audio", s.provideAudio)
			r.Get("/jobs/{id}/narration", s.getNarration)
			r.Get("/jobs/{id}/events", s.streamEvents)
			r.MethodFunc(http.MethodGet, "/jobs/{id}/artifacts/{name}", s.downloadArtifact)
			r.MethodFunc(http.MethodHead, "/jobs/{id}/artifacts/{name}", s.downloadArtifact)
			r.Post("/uploads", s.createUpload)
		})
	})

	r.NotFound(func(w http.ResponseWriter, _ *http.Request) {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "Route not found")
	})
	r.MethodNotAllowed(func(w http.ResponseWriter, _ *http.Request) {
		writeError(w, http.StatusMethodNotAllowed, "BAD_INPUT", "Method not allowed")
	})
	return r
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		next.ServeHTTP(w, r)
	})
}

func (s *Server) recoverer(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if recovered := recover(); recovered != nil {
				s.Logger.Error("panic in HTTP handler", "request_id", middleware.GetReqID(r.Context()), "panic", recovered)
				writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Internal service error")
			}
		}()
		next.ServeHTTP(w, r)
	})
}

func (s *Server) openapi(w http.ResponseWriter, _ *http.Request) {
	if s.openapiErr != nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "OpenAPI document is unavailable")
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "public, max-age=300")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(s.openapiJSON)
}

func (s *Server) getConfig(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, s.Config.Public())
}
