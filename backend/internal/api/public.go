package api

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/url"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/reasonframe/reasonframe/backend/internal/jobs"
	"github.com/reasonframe/reasonframe/backend/internal/store"
)

type publicArtifact struct {
	Name     string `json:"name"`
	MimeType string `json:"mimeType"`
	URL      string `json:"url"`
}

type publicJobError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type publicJob struct {
	ID            string           `json:"id"`
	Status        string           `json:"status"`
	Phase         string           `json:"phase"`
	Stage         string           `json:"stage"`
	CreatedAt     time.Time        `json:"createdAt"`
	UpdatedAt     time.Time        `json:"updatedAt"`
	Input         jobs.PublicInput `json:"input"`
	Attempt       int              `json:"attempt"`
	AutoRepairs   int              `json:"autoRepairs"`
	EventSequence int64            `json:"eventSequence"`
	Artifacts     []publicArtifact `json:"artifacts"`
	ScriptSHA256  string           `json:"scriptSha256,omitempty"`
	SourceSHA256  string           `json:"sourceSha256,omitempty"`
	Error         *publicJobError  `json:"error,omitempty"`
	EventsURL     string           `json:"eventsUrl"`
	NarrationURL  string           `json:"narrationUrl"`
}

func (s *Server) publicJob(ctx context.Context, job *store.Job) (*publicJob, error) {
	artifacts, err := s.Store.ListArtifacts(ctx, job.AccountID, job.ID)
	if err != nil {
		return nil, err
	}
	return buildPublicJob(job, artifacts), nil
}

func buildPublicJob(job *store.Job, artifacts []store.Artifact) *publicJob {
	var normalized jobs.NormalizedInput
	if err := json.Unmarshal(job.Input, &normalized); err != nil {
		normalized = jobs.NormalizedInput{}
	}
	out := &publicJob{
		ID: job.ID.String(), Status: string(job.Status), Phase: string(job.Phase), Stage: job.Stage,
		CreatedAt: job.CreatedAt, UpdatedAt: job.UpdatedAt,
		Input: jobs.PublicInputFrom(normalized), Attempt: job.Attempt, AutoRepairs: job.AutoRepairs,
		EventSequence: job.EventSequence,
		Artifacts:     make([]publicArtifact, 0, len(artifacts)),
		EventsURL:     fmt.Sprintf("/v1/jobs/%s/events", job.ID),
		NarrationURL:  fmt.Sprintf("/v1/jobs/%s/narration", job.ID),
	}
	if job.ScriptSHA256 != nil {
		out.ScriptSHA256 = *job.ScriptSHA256
	}
	if job.SourceSHA256 != nil {
		out.SourceSHA256 = *job.SourceSHA256
	}
	if jobErr := job.Error(); jobErr != nil {
		out.Error = &publicJobError{Code: jobErr.Code, Message: jobErr.Message}
	}
	for _, artifact := range artifacts {
		if artifact.Name == "video" && job.Status != jobs.StatusCompleted {
			continue
		}
		out.Artifacts = append(out.Artifacts, publicArtifact{
			Name: artifact.Name, MimeType: artifact.MimeType,
			URL: fmt.Sprintf("/v1/jobs/%s/artifacts/%s", job.ID, url.PathEscape(artifact.Name)),
		})
	}
	return out
}

type jobListResponse struct {
	Jobs       []*publicJob `json:"jobs"`
	NextCursor string       `json:"nextCursor,omitempty"`
}

func encodeCursor(createdAt time.Time, id uuid.UUID) string {
	return base64.RawURLEncoding.EncodeToString([]byte(createdAt.UTC().Format(time.RFC3339Nano) + "|" + id.String()))
}

func decodeCursor(value string) (*time.Time, *uuid.UUID, error) {
	raw, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil {
		return nil, nil, badInput("cursor is invalid")
	}
	parts := strings.SplitN(string(raw), "|", 2)
	if len(parts) != 2 {
		return nil, nil, badInput("cursor is invalid")
	}
	createdAt, err := time.Parse(time.RFC3339Nano, parts[0])
	if err != nil {
		return nil, nil, badInput("cursor is invalid")
	}
	id, err := uuid.Parse(parts[1])
	if err != nil {
		return nil, nil, badInput("cursor is invalid")
	}
	return &createdAt, &id, nil
}
