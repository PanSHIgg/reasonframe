package worker

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/hibiken/asynq"
	"github.com/reasonframe/reasonframe/backend/internal/ai"
	"github.com/reasonframe/reasonframe/backend/internal/ai/pipelinev1"
	"github.com/reasonframe/reasonframe/backend/internal/config"
	"github.com/reasonframe/reasonframe/backend/internal/jobs"
	"github.com/reasonframe/reasonframe/backend/internal/queue"
	"github.com/reasonframe/reasonframe/backend/internal/store"
)

var (
	errJobGone   = errors.New("job moved to another task")
	bearerFilter = regexp.MustCompile(`(?i)bearer\s+\S+`)
)

type Handler struct {
	Store    *store.Store
	Queue    *queue.Queue
	AI       *ai.Manager
	Config   config.Config
	Logger   *slog.Logger
	WorkerID string
}

func (h *Handler) Handle(ctx context.Context, task *asynq.Task) error {
	payload, err := queue.ParseTask(task)
	if err != nil {
		h.Logger.Error("discarding malformed task", "error", err)
		return nil
	}
	if payload.Phase != taskKindFromType(task.Type()) {
		h.Logger.Error("task type does not match payload phase", "type", task.Type(), "phase", payload.Phase)
		return nil
	}
	jobID, _ := uuid.Parse(payload.JobID)

	cancelCh, cancelCleanup := h.Queue.SubscribeCancel(ctx, payload.JobID)
	defer cancelCleanup()

	job, err := h.Store.GetJob(ctx, jobID)
	if errors.Is(err, store.ErrNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	if !claimable(job, payload.Phase) {
		return nil
	}

	allowed := []jobs.Status{jobs.StatusQueued}
	if payload.Phase == jobs.TaskIngest {
		allowed = append(allowed, jobs.StatusAwaitingAudio)
	}
	claimed, runID, ok, err := h.Store.ClaimJob(ctx, store.ClaimJobParams{
		JobID: jobID, TaskID: payload.TaskID(), WorkerID: h.WorkerID,
		Kind: payload.Phase, AllowedStatuses: allowed, Stage: jobs.InitialStage(payload.Phase),
		Lease: 2 * time.Minute,
	})
	if err != nil {
		return err
	}
	if !ok {
		return nil
	}

	runCtx, cancelRun := context.WithCancel(ctx)
	defer cancelRun()
	go func() {
		select {
		case <-cancelCh:
			cancelRun()
		case <-runCtx.Done():
		}
	}()

	hbCtx, stopHeartbeat := context.WithCancel(context.Background())
	defer stopHeartbeat()
	go h.heartbeat(hbCtx, jobID, payload.TaskID(), runID)

	h.Logger.Info("task started", "job_id", payload.JobID, "task_id", payload.TaskID(), "phase", payload.Phase)
	version := claimed.Version
	stage := claimed.Stage
	result, version, stage, started, err := h.runTask(runCtx, claimed, payload, version, stage)
	if err != nil {
		return h.handleRunError(ctx, claimed, payload, runID, version, started, err)
	}
	if result == nil {
		return h.handleRunError(ctx, claimed, payload, runID, version, started, errors.New("AI stream ended without a result"))
	}

	// If cancellation raced with the final result, never revive a terminal job.
	latest, loadErr := h.Store.GetJob(context.Background(), jobID)
	if loadErr == nil {
		if latest.Status == jobs.StatusCancelled || latest.Status == jobs.StatusCompleted || latest.ActiveTaskID == nil {
			status := "cancelled"
			if latest.Status != jobs.StatusCancelled {
				status = "interrupted"
			}
			_ = h.Store.FinishRun(context.Background(), runID, status, nil)
			return nil
		}
	}

	plan, updated, applyErr := h.applyResult(ctx, claimed, payload, runID, result, version, stage)
	if applyErr != nil {
		if errors.Is(applyErr, errJobGone) {
			status := "interrupted"
			if latest, loadErr := h.Store.GetJob(context.Background(), jobID); loadErr == nil && latest.Status == jobs.StatusCancelled {
				status = "cancelled"
			}
			_ = h.Store.FinishRun(context.Background(), runID, status, nil)
			return nil
		}
		_ = h.Store.FinishRun(context.Background(), runID, "failed", nil)
		return applyErr
	}

	switch plan.Action {
	case jobs.ActionAdvance, jobs.ActionComplete, jobs.ActionRepair:
		_ = h.Store.FinishRun(context.Background(), runID, "succeeded", nil)
	case jobs.ActionAwaitAudio:
		status := "succeeded"
		if payload.Phase == jobs.TaskIngest {
			status = "failed"
		}
		_ = h.Store.FinishRun(context.Background(), runID, status, nil)
	case jobs.ActionCancelled:
		_ = h.Store.FinishRun(context.Background(), runID, "cancelled", nil)
	default:
		_ = h.Store.FinishRun(context.Background(), runID, "failed", &result.ErrorCode)
	}

	if updated != nil && plan.NextTask != "" && plan.Status == jobs.StatusQueued && plan.Action != jobs.ActionRetry {
		enqueueCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := h.Queue.EnqueueJob(enqueueCtx, updated.ID.String(), plan.NextTask, updated.Attempt, updated.AutoRepairs); err != nil {
			h.Logger.Warn("enqueue next phase failed; reconciler will retry",
				"job_id", updated.ID.String(), "phase", plan.NextTask, "error", err)
		}
	}

	if plan.Action == jobs.ActionRetry {
		return fmt.Errorf("retryable failure: %s", sanitizeMessage(result.ErrorMessage))
	}
	return nil
}

func claimable(job *store.Job, kind jobs.TaskKind) bool {
	if job.Status.Terminal() {
		return false
	}
	if job.ActiveTaskID != nil {
		return false
	}
	switch kind {
	case jobs.TaskIngest:
		return job.Phase == jobs.PhasePrepare && (job.Status == jobs.StatusQueued || job.Status == jobs.StatusAwaitingAudio)
	case jobs.TaskAuthor:
		return job.Phase == jobs.PhaseAuthor && job.Status == jobs.StatusQueued
	case jobs.TaskPrepare:
		return job.Phase == jobs.PhasePrepare && job.Status == jobs.StatusQueued
	case jobs.TaskRender:
		return job.Phase == jobs.PhaseRender && job.Status == jobs.StatusQueued
	default:
		return false
	}
}

func (h *Handler) runTask(ctx context.Context, job *store.Job, payload queue.Payload, version int64, stage string) (*pipelinev1.TaskResult, int64, string, bool, error) {
	addr := h.Config.AIAddressFor(string(payload.Phase))
	if addr == "" {
		return nil, version, stage, false, fmt.Errorf("no AI address configured for %s", payload.Phase)
	}
	timeout := payload.Phase.Timeout(h.Config.TaskTimeouts)
	if timeout > 20*time.Second {
		timeout -= 15 * time.Second
	}
	aiCtx, cancelAI := context.WithTimeout(ctx, timeout)
	defer cancelAI()

	trace, _ := json.Marshal(map[string]string{"traceparent": payload.Traceparent})
	spec, err := aiSpec(job)
	if err != nil {
		return nil, version, stage, false, err
	}
	req := &pipelinev1.RunTaskRequest{
		TaskId:         payload.TaskID(),
		JobId:          job.ID.String(),
		Type:           protoType(payload.Phase),
		Attempt:        int32(job.Attempt),
		AutoRepairs:    int32(job.AutoRepairs),
		SpecJson:       spec,
		CheckpointJson: []byte(job.Checkpoint),
		TraceJson:      trace,
		DeadlineUnixMs: time.Now().Add(timeout).UnixMilli(),
	}
	stream, err := h.AI.RunTask(aiCtx, addr, req)
	if err != nil {
		return nil, version, stage, false, err
	}
	var (
		result       *pipelinev1.TaskResult
		lastProgress time.Time
		started      bool
	)
	for {
		event, err := stream.Recv()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, version, stage, started, err
		}
		started = true
		if event.Result != nil {
			result = event.Result
			continue
		}
		if ctx.Err() != nil {
			return nil, version, stage, started, ctx.Err()
		}
		if event.Type == "progress" {
			if !lastProgress.IsZero() && time.Since(lastProgress) < 2*time.Second {
				continue
			}
			lastProgress = time.Now()
		}
		newVersion, newStage, err := h.persistEvent(ctx, job.ID, payload.TaskID(), version, stage, event)
		if errors.Is(err, errJobGone) {
			return nil, version, stage, started, err
		}
		if err != nil {
			return nil, version, stage, started, err
		}
		version, stage = newVersion, newStage
	}
	return result, version, stage, started, nil
}

func (h *Handler) persistEvent(ctx context.Context, jobID uuid.UUID, taskID string, version int64, stage string, event *pipelinev1.TaskEvent) (int64, string, error) {
	eventType := event.Type
	if eventType == "" {
		eventType = "progress"
	}
	patch := store.JobPatch{}
	if event.Stage != "" && event.Stage != stage {
		stage = event.Stage
		patch.Stage = store.Set(stage)
	}
	updated, err := h.Store.UpdateJob(ctx, store.UpdateJobParams{
		JobID: jobID, ExpectVersion: &version,
		ExpectStatuses: []jobs.Status{jobs.StatusRunning},
		ActiveTaskID:   &taskID,
		Patch:          patch,
		Event: &store.NewEvent{
			Type: eventType, Stage: event.Stage, TaskID: taskID,
			Data: eventData(event.DataJson),
		},
	})
	if errors.Is(err, store.ErrConflict) {
		latest, loadErr := h.Store.GetJob(ctx, jobID)
		if loadErr != nil {
			return version, stage, loadErr
		}
		if latest.Status.Terminal() || latest.ActiveTaskID == nil || *latest.ActiveTaskID != taskID {
			return version, stage, errJobGone
		}
		// The projection may have advanced due to another event; retry once.
		updated, err = h.Store.UpdateJob(ctx, store.UpdateJobParams{
			JobID: jobID, ExpectVersion: &latest.Version,
			ExpectStatuses: []jobs.Status{jobs.StatusRunning},
			ActiveTaskID:   &taskID,
			Patch:          patch,
			Event: &store.NewEvent{
				Type: eventType, Stage: event.Stage, TaskID: taskID,
				Data: eventData(event.DataJson),
			},
		})
	}
	if err != nil {
		return version, stage, err
	}
	return updated.Version, stage, nil
}

func eventData(raw []byte) any {
	if len(raw) == 0 {
		return map[string]any{}
	}
	if json.Valid(raw) {
		return json.RawMessage(raw)
	}
	return string(raw)
}

func (h *Handler) applyResult(ctx context.Context, job *store.Job, payload queue.Payload, runID uuid.UUID, result *pipelinev1.TaskResult, version int64, stage string) (jobs.ResultPlan, *store.Job, error) {
	phaseRuns := 0
	if payload.Phase == jobs.TaskRender || payload.Phase == jobs.TaskAuthor || payload.Phase == jobs.TaskPrepare {
		count, err := h.Store.CountTaskRuns(ctx, payload.TaskID())
		if err != nil {
			return jobs.ResultPlan{}, nil, err
		}
		phaseRuns = count
	}
	plan := jobs.PlanResult(payload.Phase, result.Status, result.ErrorCode, result.Repairable, job.AutoRepairs, job.MaxAutoRepairs, phaseRuns)

	checkpoint := job.Checkpoint
	if len(result.CheckpointJson) > 0 {
		checkpoint = result.CheckpointJson
	}
	parsed := jobs.ParseCheckpoint(checkpoint)
	if payload.Phase == jobs.TaskAuthor && plan.Action == jobs.ActionAdvance {
		if !jobs.ValidSHA256(parsed.SourceSHA256) || !jobs.ValidSHA256(parsed.ScriptSHA256) {
			plan = jobs.ResultPlan{Action: jobs.ActionFail, Status: jobs.StatusFailed, Phase: jobs.PhaseAuthor, EventType: "failed"}
			result = &pipelinev1.TaskResult{
				Status: string(jobs.StatusFailed), ErrorCode: "INVALID_AI_RESULT",
				ErrorMessage: "author result did not include source_sha256 and script_sha256 in its checkpoint",
			}
		}
	}
	if payload.Phase == jobs.TaskIngest {
		ingested := plan.Action == jobs.ActionAdvance
		checkpoint = jobs.MergeCheckpoint(checkpoint, map[string]any{jobs.AudioIngestedMarker: ingested})
	} else if jobs.AudioIngested(job.Checkpoint) {
		checkpoint = jobs.MergeCheckpoint(checkpoint, map[string]any{jobs.AudioIngestedMarker: true})
	}
	now := time.Now().UTC()
	errorCode := result.ErrorCode
	errorMessage := sanitizeMessage(result.ErrorMessage)
	if errorCode == "" {
		errorCode = "GENERATION_FAILED"
	}
	if errorMessage == "" && plan.Action == jobs.ActionFail {
		errorMessage = "AI task failed"
	}

	patch := store.JobPatch{
		Checkpoint: store.Set(json.RawMessage(checkpoint)),
	}
	event := &store.NewEvent{TaskID: payload.TaskID()}
	data := map[string]any{"status": string(plan.Status), "phase": string(plan.Phase), "taskId": payload.TaskID()}

	switch plan.Action {
	case jobs.ActionAdvance:
		patch.Status = store.Set(jobs.StatusQueued)
		patch.Phase = store.Set(plan.Phase)
		patch.Stage = store.Set("queued")
		patch.Error = store.Clear[jobs.JobError]()
		patch.ActiveTaskID = store.Clear[string]()
		patch.LeaseExpiresAt = store.Clear[time.Time]()
		if payload.Phase == jobs.TaskAuthor {
			patch.SourceSHA256 = store.SetPtr(&parsed.SourceSHA256)
			patch.ScriptSHA256 = store.SetPtr(&parsed.ScriptSHA256)
			data["sourceSha256"] = parsed.SourceSHA256
			data["scriptSha256"] = parsed.ScriptSHA256
		}
		data["status"] = string(plan.Status)
		data["phase"] = string(plan.Phase)
	case jobs.ActionComplete:
		patch.Status = store.Set(jobs.StatusCompleted)
		patch.Phase = store.Set(jobs.PhaseDone)
		patch.Stage = store.Set("completed")
		patch.Error = store.Clear[jobs.JobError]()
		patch.ActiveTaskID = store.Clear[string]()
		patch.LeaseExpiresAt = store.Clear[time.Time]()
		patch.FinishedAt = store.SetPtr(&now)
		data["videoSha256"] = parsed.VideoSHA256
	case jobs.ActionAwaitAudio:
		patch.Status = store.Set(jobs.StatusAwaitingAudio)
		patch.Phase = store.Set(jobs.PhasePrepare)
		patch.Stage = store.Set("awaiting_audio")
		patch.ActiveTaskID = store.Clear[string]()
		patch.LeaseExpiresAt = store.Clear[time.Time]()
		if payload.Phase == jobs.TaskIngest && plan.Action != jobs.ActionAdvance {
			patch.Error = store.Set(&jobs.JobError{Code: errorCode, Message: errorMessage})
			data["code"] = errorCode
			data["message"] = errorMessage
		} else {
			patch.Error = store.Clear[jobs.JobError]()
			data["scriptSha256"] = job.ScriptSHA256
		}
	case jobs.ActionRepair:
		patch.Status = store.Set(jobs.StatusQueued)
		patch.Phase = store.Set(plan.Phase)
		patch.Stage = store.Set("queued")
		patch.AutoRepairs = store.Set(job.AutoRepairs + 1)
		if plan.Phase == jobs.PhaseAuthor {
			patch.SourceSHA256 = store.Clear[string]()
			patch.ScriptSHA256 = store.Clear[string]()
		}
		patch.Error = store.Set(&jobs.JobError{Code: errorCode, Message: errorMessage})
		patch.ActiveTaskID = store.Clear[string]()
		patch.LeaseExpiresAt = store.Clear[time.Time]()
		data["code"] = errorCode
		data["message"] = errorMessage
		data["autoRepairs"] = job.AutoRepairs + 1
	case jobs.ActionRetry:
		patch.Status = store.Set(jobs.StatusQueued)
		patch.Phase = store.Set(plan.Phase)
		patch.Stage = store.Set("queued")
		patch.Error = store.Set(&jobs.JobError{Code: errorCode, Message: errorMessage})
		patch.ActiveTaskID = store.Clear[string]()
		patch.LeaseExpiresAt = store.Clear[time.Time]()
		// Only model failures advance the attempt counter, which is how the AI
		// service selects the next configured provider/model. Storage/TTS
		// retries keep the same model and reuse their checkpoint.
		if errorCode == "MODEL_UNAVAILABLE" {
			patch.Attempt = store.Set(job.Attempt + 1)
			data["attempt"] = job.Attempt + 1
		}
		data["code"] = errorCode
		data["message"] = errorMessage
	case jobs.ActionCancelled:
		patch.Status = store.Set(jobs.StatusCancelled)
		patch.Stage = store.Set("cancelled")
		patch.Error = store.Clear[jobs.JobError]()
		patch.ActiveTaskID = store.Clear[string]()
		patch.LeaseExpiresAt = store.Clear[time.Time]()
		patch.FinishedAt = store.SetPtr(&now)
	default:
		patch.Status = store.Set(jobs.StatusFailed)
		patch.Stage = store.Set("failed")
		patch.Error = store.Set(&jobs.JobError{Code: errorCode, Message: errorMessage})
		patch.ActiveTaskID = store.Clear[string]()
		patch.LeaseExpiresAt = store.Clear[time.Time]()
		patch.FinishedAt = store.SetPtr(&now)
		data["code"] = errorCode
		data["message"] = errorMessage
	}

	event.Type = plan.EventType
	event.Stage = patchStageValue(patch)
	event.Data = data

	artifacts := artifactInputs(h.Logger, result.Artifacts)
	usage := usageInputs(result.Usage, payload.Phase.DBPhase())
	updated, err := h.Store.UpdateJob(ctx, store.UpdateJobParams{
		JobID: job.ID, ExpectVersion: &version,
		ExpectStatuses: []jobs.Status{jobs.StatusRunning},
		ActiveTaskID:   taskIDPtr(payload.TaskID()),
		Patch:          patch, Event: event, Artifacts: artifacts, Usage: usage,
	})
	if errors.Is(err, store.ErrConflict) {
		latest, loadErr := h.Store.GetJob(ctx, job.ID)
		if loadErr != nil {
			return plan, nil, loadErr
		}
		if latest.Status.Terminal() || latest.ActiveTaskID == nil || *latest.ActiveTaskID != payload.TaskID() {
			return plan, nil, errJobGone
		}
	}
	if err != nil {
		return plan, nil, err
	}
	_ = runID
	return plan, updated, nil
}

func patchStageValue(patch store.JobPatch) string {
	if patch.Stage.Set {
		return patch.Stage.Value
	}
	return ""
}

func artifactInputs(logger *slog.Logger, refs []*pipelinev1.ArtifactRef) []store.ArtifactInput {
	out := make([]store.ArtifactInput, 0, len(refs))
	for _, ref := range refs {
		if ref == nil || !jobs.ValidArtifactName(ref.Name) || ref.ObjectKey == "" {
			logger.Warn("ignoring invalid artifact from AI", "name", ref.GetName(), "object_key", ref.GetObjectKey())
			continue
		}
		out = append(out, store.ArtifactInput{
			Name: ref.Name, ObjectKey: ref.ObjectKey, MimeType: ref.MimeType,
			SizeBytes: ref.SizeBytes, SHA256: ref.Sha256,
		})
	}
	return out
}

func usageInputs(usage *pipelinev1.Usage, phase jobs.Phase) []store.UsageInput {
	if usage == nil {
		return nil
	}
	return []store.UsageInput{{
		Phase: phase, Provider: usage.Provider, Model: usage.Model,
		InputTokens: usage.InputTokens, OutputTokens: usage.OutputTokens,
		AudioChars: usage.AudioChars, RenderSeconds: usage.RenderSeconds, CostMicros: usage.CostMicros,
	}}
}

func (h *Handler) handleRunError(parent context.Context, job *store.Job, payload queue.Payload, runID uuid.UUID, version int64, started bool, cause error) error {
	latest, err := h.Store.GetJob(context.Background(), job.ID)
	if err == nil {
		if latest.Status == jobs.StatusCancelled {
			_ = h.Store.FinishRun(context.Background(), runID, "cancelled", nil)
			return nil
		}
		if latest.Status == jobs.StatusCompleted || latest.Status == jobs.StatusFailed {
			_ = h.Store.FinishRun(context.Background(), runID, "interrupted", nil)
			return nil
		}
	}
	if parent.Err() != nil {
		return h.markInterrupted(job, payload, runID, version, "INTERRUPTED", "Worker stopped during this task; retry to continue from verified checkpoints")
	}
	if payload.Phase == jobs.TaskAuthor && started {
		return h.markInterrupted(job, payload, runID, version, "AI_STREAM_INTERRUPTED", "AI authoring stream failed after starting; retry to continue from verified checkpoints instead of repeating paid model work")
	}
	message := sanitizeMessage(cause.Error())
	errorCode := "AI_UNAVAILABLE"
	latestVersion := version
	_, updateErr := h.Store.UpdateJob(context.Background(), store.UpdateJobParams{
		JobID: job.ID, ExpectVersion: &latestVersion,
		ExpectStatuses: []jobs.Status{jobs.StatusRunning},
		ActiveTaskID:   taskIDPtr(payload.TaskID()),
		Patch: store.JobPatch{
			Status:         store.Set(jobs.StatusQueued),
			Stage:          store.Set("queued"),
			Error:          store.Set(&jobs.JobError{Code: errorCode, Message: message}),
			ActiveTaskID:   store.Clear[string](),
			LeaseExpiresAt: store.Clear[time.Time](),
		},
		Event: &store.NewEvent{Type: "task.retry", TaskID: payload.TaskID(), Data: map[string]any{"code": errorCode, "message": message}},
	})
	_ = h.Store.FinishRun(context.Background(), runID, "failed", &errorCode)
	if updateErr != nil && !errors.Is(updateErr, store.ErrConflict) {
		h.Logger.Error("release job lease after AI error failed", "job_id", job.ID.String(), "error", updateErr)
	}
	return fmt.Errorf("%s: %w", errorCode, cause)
}

func (h *Handler) markInterrupted(job *store.Job, payload queue.Payload, runID uuid.UUID, version int64, code, message string) error {
	now := time.Now().UTC()
	_, err := h.Store.UpdateJob(context.Background(), store.UpdateJobParams{
		JobID: job.ID, ExpectVersion: &version,
		ExpectStatuses: []jobs.Status{jobs.StatusRunning},
		ActiveTaskID:   taskIDPtr(payload.TaskID()),
		Patch: store.JobPatch{
			Status:         store.Set(jobs.StatusFailed),
			Stage:          store.Set("failed"),
			Error:          store.Set(&jobs.JobError{Code: code, Message: message}),
			ActiveTaskID:   store.Clear[string](),
			LeaseExpiresAt: store.Clear[time.Time](),
			FinishedAt:     store.SetPtr(&now),
		},
		Event: &store.NewEvent{Type: "interrupted", TaskID: payload.TaskID(), Data: map[string]any{"code": code, "message": message}},
	})
	_ = h.Store.FinishRun(context.Background(), runID, "interrupted", &code)
	if err != nil && !errors.Is(err, store.ErrConflict) {
		return err
	}
	return nil
}

func (h *Handler) heartbeat(ctx context.Context, jobID uuid.UUID, taskID string, runID uuid.UUID) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := h.Store.Heartbeat(ctx, jobID, taskID, runID, 120); err != nil {
				h.Logger.Warn("heartbeat failed", "job_id", jobID.String(), "error", err)
			}
		}
	}
}

func (h *Handler) HandleError(ctx context.Context, task *asynq.Task, taskErr error) {
	payload, err := queue.ParseTask(task)
	if err != nil {
		return
	}
	retries, okRetry := asynq.GetRetryCount(ctx)
	maxRetry, okMax := asynq.GetMaxRetry(ctx)
	h.Logger.Warn("task attempt failed", "job_id", payload.JobID, "task_id", payload.TaskID(), "error", sanitizeMessage(taskErr.Error()))
	if !okRetry || !okMax || retries < maxRetry {
		return
	}
	jobID, _ := uuid.Parse(payload.JobID)
	job, err := h.Store.GetJob(context.Background(), jobID)
	if err != nil || job.Status.Terminal() || job.Status == jobs.StatusRunning {
		return
	}
	now := time.Now().UTC()
	status := jobs.StatusFailed
	stage := "failed"
	eventType := "failed"
	if payload.Phase == jobs.TaskIngest {
		status = jobs.StatusAwaitingAudio
		stage = "awaiting_audio"
		eventType = "audio.rejected"
	}
	message := sanitizeMessage(taskErr.Error())
	_, _ = h.Store.UpdateJob(context.Background(), store.UpdateJobParams{
		JobID: jobID, ExpectStatuses: []jobs.Status{jobs.StatusQueued},
		Patch: store.JobPatch{
			Status: store.Set(status), Stage: store.Set(stage),
			Error:        store.Set(&jobs.JobError{Code: "INFRA_ERROR", Message: message}),
			ActiveTaskID: store.Clear[string](), LeaseExpiresAt: store.Clear[time.Time](),
			FinishedAt: store.SetPtr(&now),
		},
		Event: &store.NewEvent{Type: eventType, TaskID: payload.TaskID(), Data: map[string]any{"code": "INFRA_ERROR", "message": message}},
	})
}

// aiSpec sends the canonical task input without the inline audio wrapper. The
// AI service expects audio and words as top-level binary references.
func aiSpec(job *store.Job) ([]byte, error) {
	var input jobs.NormalizedInput
	if err := json.Unmarshal(job.Input, &input); err != nil {
		return nil, fmt.Errorf("decode normalized job input: %w", err)
	}
	audio := input.Audio
	input.Audio = nil
	payload := map[string]any{
		"schemaVersion":   1,
		"jobId":           job.ID.String(),
		"input":           input,
		"artifactVersion": strconv.Itoa(job.Attempt + 1),
		"repair":          job.AutoRepairs > 0,
	}
	if audio != nil {
		payload["audio"] = map[string]any{
			"objectKey":    audio.AudioObjectKey,
			"scriptSha256": audio.ScriptSHA256,
		}
		payload["words"] = map[string]any{"objectKey": audio.WordsObjectKey}
	}
	return json.Marshal(payload)
}

func protoType(kind jobs.TaskKind) pipelinev1.TaskType {
	switch kind {
	case jobs.TaskAuthor:
		return pipelinev1.TaskType_AUTHOR
	case jobs.TaskPrepare:
		return pipelinev1.TaskType_PREPARE
	case jobs.TaskRender:
		return pipelinev1.TaskType_RENDER
	case jobs.TaskIngest:
		return pipelinev1.TaskType_INGEST_AUDIO
	default:
		return pipelinev1.TaskType_TASK_TYPE_UNSPECIFIED
	}
}

func taskKindFromType(taskType string) jobs.TaskKind {
	return jobs.TaskKind(strings.TrimPrefix(taskType, "pipeline:"))
}

func sanitizeMessage(message string) string {
	message = bearerFilter.ReplaceAllString(message, "Bearer [REDACTED]")
	if len(message) > 4000 {
		message = message[:4000]
	}
	return message
}

func taskIDPtr(value string) *string { return &value }
