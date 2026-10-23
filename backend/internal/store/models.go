package store

import (
	"encoding/json"
	"time"

	"github.com/google/uuid"
	"github.com/reasonframe/reasonframe/backend/internal/jobs"
)

type Account struct {
	ID        uuid.UUID
	Slug      string
	Name      string
	CreatedAt time.Time
}

type APIKey struct {
	ID         uuid.UUID
	AccountID  uuid.UUID
	Name       string
	KeyPrefix  string
	KeyHash    []byte
	Scopes     []string
	ExpiresAt  *time.Time
	RevokedAt  *time.Time
	LastUsedAt *time.Time
	CreatedAt  time.Time
}

type Job struct {
	ID             uuid.UUID
	AccountID      uuid.UUID
	Status         jobs.Status
	Phase          jobs.Phase
	Stage          string
	Priority       int16
	Input          json.RawMessage
	Options        json.RawMessage
	IdempotencyKey *string
	RequestSHA256  *string
	Attempt        int
	AutoRepairs    int
	MaxAutoRepairs int
	SourceSHA256   *string
	ScriptSHA256   *string
	Checkpoint     json.RawMessage
	ErrorCode      *string
	ErrorMessage   *string
	ActiveTaskID   *string
	LeaseExpiresAt *time.Time
	Version        int64
	EventSequence  int64
	CreatedAt      time.Time
	UpdatedAt      time.Time
	StartedAt      *time.Time
	FinishedAt     *time.Time
}

func (j *Job) Error() *jobs.JobError {
	if j.ErrorCode == nil || *j.ErrorCode == "" {
		return nil
	}
	message := ""
	if j.ErrorMessage != nil {
		message = *j.ErrorMessage
	}
	return &jobs.JobError{Code: *j.ErrorCode, Message: message}
}

type Artifact struct {
	ID           uuid.UUID
	JobID        uuid.UUID
	Name         string
	Version      int
	ObjectKey    string
	MimeType     string
	SizeBytes    int64
	SHA256       string
	State        string
	IsCurrent    bool
	SourceSHA256 *string
	CreatedAt    time.Time
}

type Event struct {
	ID        int64
	JobID     uuid.UUID
	Type      string
	Stage     string
	TaskID    string
	Data      json.RawMessage
	CreatedAt time.Time
}

type NewEvent struct {
	Type      string
	Stage     string
	TaskID    string
	Data      any
	CreatedAt time.Time
}

type Upload struct {
	ID        uuid.UUID
	AccountID uuid.UUID
	JobID     *uuid.UUID
	Kind      string
	ObjectKey string
	MimeType  *string
	SizeBytes *int64
	SHA256    *string
	State     string
	ExpiresAt time.Time
	CreatedAt time.Time
}

type Run struct {
	ID          uuid.UUID
	JobID       uuid.UUID
	Phase       jobs.Phase
	TaskID      string
	RunAttempt  int
	WorkerID    string
	Status      string
	ErrorCode   *string
	StartedAt   time.Time
	HeartbeatAt time.Time
	FinishedAt  *time.Time
}

type UsageInput struct {
	Phase         jobs.Phase
	Provider      string
	Model         string
	InputTokens   int64
	OutputTokens  int64
	AudioChars    int64
	RenderSeconds float64
	CostMicros    int64
	Metadata      json.RawMessage
}

type ArtifactInput struct {
	Name      string
	ObjectKey string
	MimeType  string
	SizeBytes int64
	SHA256    string
}
