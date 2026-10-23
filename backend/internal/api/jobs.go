package api

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/reasonframe/reasonframe/backend/internal/auth"
	"github.com/reasonframe/reasonframe/backend/internal/jobs"
	"github.com/reasonframe/reasonframe/backend/internal/store"
)

const maxJSONBody int64 = 70 << 20

func principalOf(r *http.Request) (auth.Principal, bool) {
	return auth.FromContext(r.Context())
}

func parseJobID(r *http.Request) (uuid.UUID, error) {
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		return uuid.Nil, notFound("Job not found")
	}
	return id, nil
}

func newID() uuid.UUID {
	if id, err := uuid.NewV7(); err == nil {
		return id
	}
	return uuid.New()
}

func decodeStrictJSON(body []byte, dst any) error {
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(dst); err != nil {
		return badInput("request body: " + err.Error())
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return badInput("request body must contain exactly one JSON value")
	}
	return nil
}

func (s *Server) listJobs(w http.ResponseWriter, r *http.Request) {
	principal, ok := principalOf(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Valid service bearer token required")
		return
	}
	limit := 100
	if raw := r.URL.Query().Get("limit"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 1 || parsed > 100 {
			s.writeMappedError(w, r, badInput("limit must be an integer in 1..100"))
			return
		}
		limit = parsed
	}
	params := store.ListJobsParams{AccountID: principal.AccountID, Limit: limit + 1}
	if cursor := r.URL.Query().Get("cursor"); cursor != "" {
		createdAt, id, err := decodeCursor(cursor)
		if err != nil {
			s.writeMappedError(w, r, err)
			return
		}
		params.BeforeCreatedAt = createdAt
		params.BeforeID = id
	}
	list, err := s.Store.ListJobs(r.Context(), params)
	if err != nil {
		s.writeMappedError(w, r, err)
		return
	}
	nextCursor := ""
	if len(list) > limit {
		list = list[:limit]
		last := list[len(list)-1]
		nextCursor = encodeCursor(last.CreatedAt, last.ID)
	}
	ids := make([]uuid.UUID, len(list))
	for i := range list {
		ids[i] = list[i].ID
	}
	artifacts, err := s.Store.ListArtifactsForJobs(r.Context(), principal.AccountID, ids)
	if err != nil {
		s.writeMappedError(w, r, err)
		return
	}
	response := jobListResponse{Jobs: make([]*publicJob, 0, len(list)), NextCursor: nextCursor}
	for i := range list {
		response.Jobs = append(response.Jobs, buildPublicJob(&list[i], artifacts[list[i].ID]))
	}
	writeJSON(w, http.StatusOK, response)
}

func (s *Server) createJob(w http.ResponseWriter, r *http.Request) {
	principal, ok := principalOf(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Valid service bearer token required")
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxJSONBody))
	if err != nil {
		s.writeMappedError(w, r, err)
		return
	}
	requestHash := sha256.Sum256(body)
	hashHex := hex.EncodeToString(requestHash[:])
	idempotencyKey := strings.TrimSpace(r.Header.Get("Idempotency-Key"))
	if len(idempotencyKey) > 200 {
		s.writeMappedError(w, r, badInput("Idempotency-Key must contain at most 200 characters"))
		return
	}
	if idempotencyKey != "" {
		existing, lookupErr := s.Store.GetJobByKey(r.Context(), principal.AccountID, idempotencyKey)
		if lookupErr == nil {
			if existing.RequestSHA256 == nil || *existing.RequestSHA256 != hashHex {
				s.writeMappedError(w, r, store.ErrIdempotencyConflict)
				return
			}
			public, err := s.publicJob(r.Context(), existing)
			if err != nil {
				s.writeMappedError(w, r, err)
				return
			}
			w.Header().Set("Location", "/v1/jobs/"+existing.ID.String())
			writeJSON(w, http.StatusAccepted, public)
			return
		}
		if !errors.Is(lookupErr, store.ErrNotFound) {
			s.writeMappedError(w, r, lookupErr)
			return
		}
	}

	var input jobs.JobInput
	if err := decodeStrictJSON(body, &input); err != nil {
		s.writeMappedError(w, r, err)
		return
	}
	jobs.ApplyInputDefaults(&input)
	if err := jobs.ValidateJobInput(&input, s.Config.MaxImageBytes); err != nil {
		s.writeMappedError(w, r, err)
		return
	}
	usage, err := s.Store.QuotaUsage(r.Context(), principal.AccountID)
	if err != nil {
		s.writeMappedError(w, r, err)
		return
	}
	if usage.Running >= s.Config.AccountMaxActiveJobs || usage.Queued >= s.Config.AccountMaxQueuedJobs {
		writeError(w, http.StatusTooManyRequests, "QUOTA_EXCEEDED", "Account job quota exceeded; wait for active or queued jobs to finish")
		return
	}

	jobID := newID()
	images := make([]jobs.NormalizedImage, 0, len(input.Images))
	uploadIDs := make([]uuid.UUID, 0, len(input.Images))
	objectKeys := make([]string, 0, len(input.Images))
	for i, image := range input.Images {
		if image.UploadID != "" {
			uploadID, err := uuid.Parse(image.UploadID)
			if err != nil {
				s.writeMappedError(w, r, jobs.Errorf("UPLOAD_INVALID", fmt.Sprintf("images.%d.uploadId is invalid", i)))
				return
			}
			upload, err := s.Store.GetUpload(r.Context(), principal.AccountID, uploadID)
			if err != nil {
				s.writeMappedError(w, r, jobs.Errorf("UPLOAD_INVALID", fmt.Sprintf("images.%d upload was not found or has expired", i)))
				return
			}
			if upload.Kind != string(jobs.UploadImage) {
				s.writeMappedError(w, r, jobs.Errorf("UPLOAD_INVALID", fmt.Sprintf("images.%d upload is not an image", i)))
				return
			}
			mime := ""
			if upload.MimeType != nil {
				mime = *upload.MimeType
			}
			sha := ""
			if upload.SHA256 != nil {
				sha = *upload.SHA256
			}
			images = append(images, jobs.NormalizedImage{
				MimeType: mime, ObjectKey: upload.ObjectKey, SHA256: sha,
				File: fmt.Sprintf("inputs/problem-%d.%s", i+1, jobs.ImageExtension(mime)),
			})
			uploadIDs = append(uploadIDs, uploadID)
			continue
		}
		data, err := decodeBase64(image.Base64)
		if err != nil {
			s.writeMappedError(w, r, badInput(fmt.Sprintf("images.%d.base64 must be valid standard base64", i)))
			return
		}
		mime, err := jobs.ValidateUpload(jobs.UploadImage, image.MimeType, data, s.Config.MaxImageBytes, s.Config.MaxAudioBytes)
		if err != nil {
			s.writeMappedError(w, r, err)
			return
		}
		key := fmt.Sprintf("jobs/%s/input/problem-%d.%s", jobID, i+1, jobs.ImageExtension(mime))
		if err := s.Storage.PutBytes(r.Context(), key, data, mime); err != nil {
			s.writeMappedError(w, r, jobs.Errorf("SERVICE_UNAVAILABLE", "Object storage is unavailable"))
			return
		}
		images = append(images, jobs.NormalizedImage{
			MimeType: mime, ObjectKey: key, SHA256: sha256Hex(data),
			File: fmt.Sprintf("inputs/problem-%d.%s", i+1, jobs.ImageExtension(mime)),
		})
		objectKeys = append(objectKeys, key)
	}

	normalized := jobs.NormalizedInput{
		Problem: input.Problem, Images: images, Scope: input.Scope,
		Supplements: input.Supplements, Options: input.Options,
	}
	inputJSON, _ := json.Marshal(normalized)
	optionsJSON, _ := json.Marshal(input.Options)
	var keyPtr *string
	if idempotencyKey != "" {
		keyPtr = &idempotencyKey
	}
	job, created, err := s.Store.CreateJob(r.Context(), store.CreateJobParams{
		ID: jobID, AccountID: principal.AccountID, Input: inputJSON, Options: optionsJSON,
		IdempotencyKey: keyPtr, RequestSHA256: hashHex,
		MaxAutoRepairs: s.Config.AgentConfig.VisualMaxRepairAttempts,
	})
	if err != nil {
		for _, key := range objectKeys {
			_ = s.Storage.Remove(context.Background(), key)
		}
		s.writeMappedError(w, r, err)
		return
	}
	if !created {
		for _, key := range objectKeys {
			_ = s.Storage.Remove(context.Background(), key)
		}
	}
	if created {
		for _, uploadID := range uploadIDs {
			if err := s.Store.AttachUpload(r.Context(), principal.AccountID, uploadID, job.ID); err != nil {
				s.Logger.Warn("attach upload to job failed", "job_id", job.ID.String(), "upload_id", uploadID.String(), "error", err)
			}
		}
		if s.Queue != nil {
			if err := s.Queue.EnqueueJob(r.Context(), job.ID.String(), jobs.TaskAuthor, job.Attempt, job.AutoRepairs); err != nil {
				s.Logger.Warn("enqueue author failed; reconciler will retry", "job_id", job.ID.String(), "error", err)
			}
		}
	}
	public, err := s.publicJob(r.Context(), job)
	if err != nil {
		s.writeMappedError(w, r, err)
		return
	}
	w.Header().Set("Location", "/v1/jobs/"+job.ID.String())
	writeJSON(w, http.StatusAccepted, public)
}

func (s *Server) getJob(w http.ResponseWriter, r *http.Request) {
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
	job, err := s.Store.GetJobForAccount(r.Context(), principal.AccountID, jobID)
	if err != nil {
		s.writeMappedError(w, r, err)
		return
	}
	public, err := s.publicJob(r.Context(), job)
	if err != nil {
		s.writeMappedError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, public)
}

func (s *Server) cancelJob(w http.ResponseWriter, r *http.Request) {
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
	job, err := s.Store.CancelJob(r.Context(), principal.AccountID, jobID)
	if err != nil {
		s.writeMappedError(w, r, err)
		return
	}
	if s.Queue != nil {
		s.Queue.DeleteJobTasks(r.Context(), job.ID.String(), job.Attempt, job.AutoRepairs)
		if err := s.Queue.PublishCancel(r.Context(), job.ID.String()); err != nil {
			s.Logger.Warn("publish cancellation failed", "job_id", job.ID.String(), "error", err)
		}
	}
	public, err := s.publicJob(r.Context(), job)
	if err != nil {
		s.writeMappedError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, public)
}

func (s *Server) retryJob(w http.ResponseWriter, r *http.Request) {
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
	current, err := s.Store.GetJobForAccount(r.Context(), principal.AccountID, jobID)
	if err != nil {
		s.writeMappedError(w, r, err)
		return
	}
	phase := jobs.RecoveryPhase(current.Phase)
	job, err := s.Store.RetryJob(r.Context(), principal.AccountID, jobID, phase)
	if err != nil {
		s.writeMappedError(w, r, err)
		return
	}
	if s.Queue != nil {
		kind := jobs.QueuedKind(job.Phase, job.Input, job.Checkpoint)
		if kind != "" {
			if err := s.Queue.EnqueueJob(r.Context(), job.ID.String(), kind, job.Attempt, job.AutoRepairs); err != nil {
				s.Logger.Warn("enqueue retry failed; reconciler will retry", "job_id", job.ID.String(), "error", err)
			}
		}
	}
	public, err := s.publicJob(r.Context(), job)
	if err != nil {
		s.writeMappedError(w, r, err)
		return
	}
	writeJSON(w, http.StatusAccepted, public)
}

func decodeBase64(value string) ([]byte, error) {
	if data, err := base64.StdEncoding.DecodeString(value); err == nil {
		return data, nil
	}
	return base64.RawStdEncoding.DecodeString(value)
}

func (s *Server) provideAudio(w http.ResponseWriter, r *http.Request) {
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
	job, err := s.Store.GetJobForAccount(r.Context(), principal.AccountID, jobID)
	if err != nil {
		s.writeMappedError(w, r, err)
		return
	}
	if job.Status != jobs.StatusAwaitingAudio {
		writeError(w, http.StatusConflict, "INVALID_STATE", "Audio can only be supplied while awaiting_audio")
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxJSONBody))
	if err != nil {
		s.writeMappedError(w, r, err)
		return
	}
	var request struct {
		ScriptSHA256  string          `json:"scriptSha256"`
		AudioBase64   string          `json:"audioBase64"`
		Words         json.RawMessage `json:"words"`
		AudioUploadID string          `json:"audioUploadId"`
		WordsUploadID string          `json:"wordsUploadId"`
	}
	if err := decodeStrictJSON(body, &request); err != nil {
		s.writeMappedError(w, r, err)
		return
	}
	if !jobs.ValidSHA256(request.ScriptSHA256) {
		s.writeMappedError(w, r, badInput("scriptSha256 must be 64 lowercase hex characters"))
		return
	}
	if job.ScriptSHA256 == nil || *job.ScriptSHA256 != request.ScriptSHA256 {
		s.writeMappedError(w, r, jobs.Errorf("STALE_AUDIO", "MP3/word table belong to a different narration; fetch the current narration and regenerate the whole audio"))
		return
	}
	if request.AudioBase64 == "" && request.AudioUploadID == "" || request.AudioBase64 != "" && request.AudioUploadID != "" {
		s.writeMappedError(w, r, badInput("provide exactly one of audioBase64 or audioUploadId"))
		return
	}
	hasInlineWords := len(request.Words) > 0 && string(request.Words) != "null"
	if hasInlineWords && request.WordsUploadID != "" || !hasInlineWords && request.WordsUploadID == "" {
		s.writeMappedError(w, r, badInput("provide exactly one of words or wordsUploadId"))
		return
	}

	var audioKey, audioSHA string
	uploadIDs := []uuid.UUID{}
	if request.AudioUploadID != "" {
		uploadID, parseErr := uuid.Parse(request.AudioUploadID)
		if parseErr != nil {
			s.writeMappedError(w, r, jobs.Errorf("UPLOAD_INVALID", "audioUploadId is invalid"))
			return
		}
		upload, lookupErr := s.Store.GetUpload(r.Context(), principal.AccountID, uploadID)
		if lookupErr != nil || upload.Kind != string(jobs.UploadAudio) {
			s.writeMappedError(w, r, jobs.Errorf("UPLOAD_INVALID", "audio upload was not found or has expired"))
			return
		}
		audioKey = upload.ObjectKey
		if upload.SHA256 != nil {
			audioSHA = *upload.SHA256
		}
		uploadIDs = append(uploadIDs, uploadID)
	} else {
		data, decodeErr := decodeBase64(request.AudioBase64)
		if decodeErr != nil {
			s.writeMappedError(w, r, jobs.Errorf("AUDIO_REJECTED", "audioBase64 must be valid base64"))
			return
		}
		if _, validateErr := jobs.ValidateAudioBytes("audio/mpeg", data, s.Config.MaxAudioBytes); validateErr != nil {
			s.writeMappedError(w, r, validateErr)
			return
		}
		audioKey = fmt.Sprintf("jobs/%s/input/narration.mp3", job.ID)
		if putErr := s.Storage.PutBytes(r.Context(), audioKey, data, "audio/mpeg"); putErr != nil {
			s.writeMappedError(w, r, jobs.Errorf("SERVICE_UNAVAILABLE", "Object storage is unavailable"))
			return
		}
		audioSHA = sha256Hex(data)
	}

	var wordsKey, wordsSHA string
	if request.WordsUploadID != "" {
		uploadID, parseErr := uuid.Parse(request.WordsUploadID)
		if parseErr != nil {
			s.writeMappedError(w, r, jobs.Errorf("UPLOAD_INVALID", "wordsUploadId is invalid"))
			return
		}
		upload, lookupErr := s.Store.GetUpload(r.Context(), principal.AccountID, uploadID)
		if lookupErr != nil || upload.Kind != string(jobs.UploadWords) {
			s.writeMappedError(w, r, jobs.Errorf("UPLOAD_INVALID", "words upload was not found or has expired"))
			return
		}
		data, readErr := s.Storage.ReadAll(r.Context(), upload.ObjectKey, jobs.MaxWordsBytes)
		if readErr != nil {
			s.writeMappedError(w, r, jobs.Errorf("UPLOAD_INVALID", "words upload is unavailable"))
			return
		}
		if _, validateErr := jobs.ParseWordTable(data, request.ScriptSHA256); validateErr != nil {
			s.writeMappedError(w, r, validateErr)
			return
		}
		wordsKey = upload.ObjectKey
		if upload.SHA256 != nil {
			wordsSHA = *upload.SHA256
		} else {
			wordsSHA = sha256Hex(data)
		}
		uploadIDs = append(uploadIDs, uploadID)
	} else {
		if _, validateErr := jobs.ParseWordTable(request.Words, request.ScriptSHA256); validateErr != nil {
			s.writeMappedError(w, r, validateErr)
			return
		}
		wordsKey = fmt.Sprintf("jobs/%s/input/words.json", job.ID)
		if putErr := s.Storage.PutBytes(r.Context(), wordsKey, request.Words, "application/json"); putErr != nil {
			s.writeMappedError(w, r, jobs.Errorf("SERVICE_UNAVAILABLE", "Object storage is unavailable"))
			return
		}
		wordsSHA = sha256Hex(request.Words)
	}

	var normalized jobs.NormalizedInput
	if err := json.Unmarshal(job.Input, &normalized); err != nil {
		s.writeMappedError(w, r, jobs.Errorf("INTERNAL_ERROR", "Stored job input is invalid"))
		return
	}
	normalized.Audio = &jobs.AudioRef{
		AudioObjectKey: audioKey, WordsObjectKey: wordsKey, ScriptSHA256: request.ScriptSHA256,
	}
	inputJSON, _ := json.Marshal(normalized)
	checkpoint := jobs.MergeCheckpoint(job.Checkpoint, map[string]any{jobs.AudioIngestedMarker: false})
	version := job.Version
	updated, err := s.Store.UpdateJob(r.Context(), store.UpdateJobParams{
		JobID: job.ID, AccountID: &principal.AccountID, ExpectVersion: &version,
		ExpectStatuses: []jobs.Status{jobs.StatusAwaitingAudio},
		Patch: store.JobPatch{
			Status:         store.Set(jobs.StatusQueued),
			Phase:          store.Set(jobs.PhasePrepare),
			Stage:          store.Set("queued"),
			Input:          store.Set(json.RawMessage(inputJSON)),
			Checkpoint:     store.Set(json.RawMessage(checkpoint)),
			Error:          store.Clear[jobs.JobError](),
			ActiveTaskID:   store.Clear[string](),
			LeaseExpiresAt: store.Clear[time.Time](),
			FinishedAt:     store.Clear[time.Time](),
		},
		Event: &store.NewEvent{Type: "audio.accepted", Data: map[string]any{
			"scriptSha256": request.ScriptSHA256, "audioSha256": audioSHA, "wordsSha256": wordsSHA,
		}},
	})
	if err != nil {
		s.writeMappedError(w, r, err)
		return
	}
	for _, uploadID := range uploadIDs {
		_ = s.Store.AttachUpload(r.Context(), principal.AccountID, uploadID, job.ID)
	}
	if s.Queue != nil {
		if err := s.Queue.EnqueueJob(r.Context(), job.ID.String(), jobs.TaskIngest, updated.Attempt, updated.AutoRepairs); err != nil {
			s.Logger.Warn("enqueue audio ingest failed; reconciler will retry", "job_id", job.ID.String(), "error", err)
		}
	}
	public, err := s.publicJob(r.Context(), updated)
	if err != nil {
		s.writeMappedError(w, r, err)
		return
	}
	writeJSON(w, http.StatusAccepted, public)
}

func sha256Hex(data []byte) string {
	digest := sha256.Sum256(data)
	return hex.EncodeToString(digest[:])
}
