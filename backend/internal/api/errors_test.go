package api

import (
	"net/http"
	"testing"
	"time"
)

func TestStatusForCodeMatchesPublicContract(t *testing.T) {
	cases := map[string]int{
		"BAD_INPUT":            http.StatusUnprocessableEntity,
		"INVALID_STATE":        http.StatusConflict,
		"NOT_FOUND":            http.StatusNotFound,
		"UNAUTHORIZED":         http.StatusUnauthorized,
		"PAYLOAD_TOO_LARGE":    http.StatusRequestEntityTooLarge,
		"UPLOAD_INVALID":       http.StatusUnprocessableEntity,
		"IDEMPOTENCY_CONFLICT": http.StatusConflict,
		"QUOTA_EXCEEDED":       http.StatusTooManyRequests,
		"RATE_LIMITED":         http.StatusTooManyRequests,
		"SERVICE_UNAVAILABLE":  http.StatusServiceUnavailable,
		"MODEL_NOT_CONFIGURED": http.StatusServiceUnavailable,
		"SERVICE_STOPPING":     http.StatusServiceUnavailable,
		"INTERNAL_ERROR":       http.StatusInternalServerError,
	}
	for code, want := range cases {
		if got := statusForCode(code); got != want {
			t.Fatalf("statusForCode(%s)=%d want %d", code, got, want)
		}
	}
}

func TestCursorRoundTrip(t *testing.T) {
	id := newID()
	cursor := encodeCursor(testTime, id)
	createdAt, parsedID, err := decodeCursor(cursor)
	if err != nil {
		t.Fatal(err)
	}
	if !createdAt.Equal(testTime) || *parsedID != id {
		t.Fatalf("cursor round trip mismatch: %v %v", createdAt, parsedID)
	}
	if _, _, err := decodeCursor("not-a-cursor"); err == nil {
		t.Fatal("invalid cursor accepted")
	}
}

var testTime = time.Date(2026, 10, 22, 12, 0, 0, 123456789, time.UTC)
