package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5/middleware"
	"github.com/reasonframe/reasonframe/backend/internal/jobs"
	"github.com/reasonframe/reasonframe/backend/internal/store"
)

type errorBody struct {
	Error errorDetail `json:"error"`
}

type errorDetail struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, errorBody{Error: errorDetail{Code: code, Message: message}})
}

func statusForCode(code string) int {
	switch code {
	case "NOT_FOUND":
		return http.StatusNotFound
	case "INVALID_STATE", "IDEMPOTENCY_CONFLICT":
		return http.StatusConflict
	case "UNAUTHORIZED":
		return http.StatusUnauthorized
	case "FORBIDDEN":
		return http.StatusForbidden
	case "PAYLOAD_TOO_LARGE":
		return http.StatusRequestEntityTooLarge
	case "RATE_LIMITED", "QUOTA_EXCEEDED":
		return http.StatusTooManyRequests
	case "MODEL_NOT_CONFIGURED", "SERVICE_UNAVAILABLE", "SERVICE_STOPPING":
		return http.StatusServiceUnavailable
	case "INTERNAL_ERROR":
		return http.StatusInternalServerError
	default:
		return http.StatusUnprocessableEntity
	}
}

func (s *Server) writeMappedError(w http.ResponseWriter, r *http.Request, err error) {
	var coded *jobs.CodedError
	var maxBytes *http.MaxBytesError
	switch {
	case errors.As(err, &coded):
		writeError(w, statusForCode(coded.Code), coded.Code, coded.Message)
		return
	case errors.As(err, &maxBytes):
		writeError(w, http.StatusRequestEntityTooLarge, "PAYLOAD_TOO_LARGE", "Request body is too large")
		return
	case errors.Is(err, store.ErrNotFound):
		writeError(w, http.StatusNotFound, "NOT_FOUND", "Job or resource not found")
		return
	case errors.Is(err, store.ErrConflict):
		writeError(w, http.StatusConflict, "INVALID_STATE", "Job state does not allow this operation")
		return
	case errors.Is(err, store.ErrIdempotencyConflict):
		writeError(w, http.StatusConflict, "IDEMPOTENCY_CONFLICT", "Idempotency-Key was already used with a different request")
		return
	case errors.Is(err, store.ErrExpired):
		writeError(w, http.StatusUnprocessableEntity, "UPLOAD_INVALID", "Upload has expired")
		return
	case strings.Contains(strings.ToLower(err.Error()), "request body too large"),
		strings.Contains(strings.ToLower(err.Error()), "message too large"):
		writeError(w, http.StatusRequestEntityTooLarge, "PAYLOAD_TOO_LARGE", "Request body is too large")
		return
	}
	s.Logger.Error("request failed", "request_id", middleware.GetReqID(r.Context()), "error", err)
	writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Internal service error")
}

func badInput(message string) error {
	return jobs.Errorf("BAD_INPUT", message)
}

func notFound(message string) error {
	return jobs.Errorf("NOT_FOUND", message)
}
