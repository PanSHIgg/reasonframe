package queue

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"

	"github.com/google/uuid"
	"github.com/hibiken/asynq"
	"github.com/reasonframe/reasonframe/backend/internal/jobs"
)

const taskPrefix = "pipeline:"

type Payload struct {
	JobID       string        `json:"job_id"`
	Phase       jobs.TaskKind `json:"phase"`
	Attempt     int           `json:"attempt"`
	AutoRepairs int           `json:"auto_repairs"`
	Traceparent string        `json:"traceparent,omitempty"`
}

func NewPayload(jobID string, kind jobs.TaskKind, attempt, autoRepairs int) Payload {
	return Payload{JobID: jobID, Phase: kind, Attempt: attempt, AutoRepairs: autoRepairs, Traceparent: newTraceparent()}
}

func (p Payload) TaskID() string {
	return fmt.Sprintf("%s:%s:%d:%d", p.JobID, p.Phase, p.Attempt, p.AutoRepairs)
}

func TaskType(kind jobs.TaskKind) string { return taskPrefix + string(kind) }

func NewTask(p Payload) (*asynq.Task, error) {
	if _, err := uuid.Parse(p.JobID); err != nil {
		return nil, fmt.Errorf("invalid job id: %w", err)
	}
	if !p.Phase.Valid() {
		return nil, fmt.Errorf("invalid task phase %q", p.Phase)
	}
	body, err := json.Marshal(p)
	if err != nil {
		return nil, err
	}
	return asynq.NewTask(TaskType(p.Phase), body), nil
}

func ParseTask(task *asynq.Task) (Payload, error) {
	var p Payload
	if err := json.Unmarshal(task.Payload(), &p); err != nil {
		return Payload{}, err
	}
	if _, err := uuid.Parse(p.JobID); err != nil {
		return Payload{}, fmt.Errorf("payload has invalid job_id: %w", err)
	}
	if !p.Phase.Valid() {
		return Payload{}, fmt.Errorf("payload has invalid phase %q", p.Phase)
	}
	return p, nil
}

func newTraceparent() string {
	traceID := make([]byte, 16)
	spanID := make([]byte, 8)
	if _, err := rand.Read(traceID); err != nil {
		return ""
	}
	if _, err := rand.Read(spanID); err != nil {
		return ""
	}
	return "00-" + hex.EncodeToString(traceID) + "-" + hex.EncodeToString(spanID) + "-01"
}
