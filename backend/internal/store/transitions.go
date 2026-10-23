package store

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/reasonframe/reasonframe/backend/internal/jobs"
)

type ClaimJobParams struct {
	JobID           uuid.UUID
	TaskID          string
	WorkerID        string
	Kind            jobs.TaskKind
	AllowedStatuses []jobs.Status
	Stage           string
	Lease           time.Duration
}

// ClaimJob atomically moves a claimable job to running and creates a run row.
// If the job was advanced or cancelled by another actor, it returns claimed=false.
func (s *Store) ClaimJob(ctx context.Context, p ClaimJobParams) (*Job, uuid.UUID, bool, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, uuid.Nil, false, err
	}
	defer func() { _ = tx.Rollback(context.Background()) }()

	statuses := make([]string, len(p.AllowedStatuses))
	for i, status := range p.AllowedStatuses {
		statuses[i] = string(status)
	}
	leaseSeconds := int(p.Lease / time.Second)
	if leaseSeconds < 30 {
		leaseSeconds = 30
	}
	stage := p.Stage
	if stage == "" {
		stage = jobs.InitialStage(p.Kind)
	}
	var claimedID uuid.UUID
	err = tx.QueryRow(ctx, `UPDATE jobs SET
		status='running', phase=$2, stage=$3, active_task_id=$4,
		lease_expires_at=now()+($5::int * interval '1 second'),
		version=version+1, updated_at=now(),
		started_at=COALESCE(started_at, now()),
		error_code=NULL, error_message=NULL
		WHERE id=$1 AND active_task_id IS NULL AND status::text = ANY($6) AND phase::text=$7
		RETURNING id`,
		p.JobID, string(p.Kind.DBPhase()), stage, p.TaskID, leaseSeconds, statuses, string(p.Kind.DBPhase())).Scan(&claimedID)
	if errors.Is(err, pgx.ErrNoRows) {
		_ = tx.Rollback(ctx)
		return nil, uuid.Nil, false, nil
	}
	if err != nil {
		return nil, uuid.Nil, false, err
	}
	runID := uuid.New()
	var runAttempt int
	if err := tx.QueryRow(ctx, `SELECT COALESCE(MAX(run_attempt),0)+1 FROM job_runs WHERE task_id=$1`, p.TaskID).Scan(&runAttempt); err != nil {
		return nil, uuid.Nil, false, err
	}
	_, err = tx.Exec(ctx, `INSERT INTO job_runs
		(id, job_id, phase, task_id, run_attempt, worker_id, status)
		VALUES ($1,$2,$3,$4,$5,$6,'running')`,
		runID, p.JobID, string(p.Kind.DBPhase()), p.TaskID, runAttempt, p.WorkerID)
	if err != nil {
		return nil, uuid.Nil, false, err
	}
	_, _ = tx.Exec(ctx, `UPDATE job_runs SET status='interrupted', finished_at=now()
		WHERE job_id=$1 AND status='running' AND id<>$2`, p.JobID, runID)
	eventID, err := insertEventTx(ctx, tx, p.JobID, NewEvent{
		Type: "task.started", TaskID: p.TaskID,
		Data: map[string]any{"taskId": p.TaskID, "phase": string(p.Kind), "workerId": p.WorkerID},
	})
	if err != nil {
		return nil, uuid.Nil, false, err
	}
	if err := notifyTx(ctx, tx, p.JobID, eventID); err != nil {
		return nil, uuid.Nil, false, err
	}
	job, err := s.getJob(ctx, tx, "WHERE id=$1", p.JobID)
	if err != nil {
		return nil, uuid.Nil, false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, uuid.Nil, false, err
	}
	return job, runID, true, nil
}

func (s *Store) CancelJob(ctx context.Context, accountID, jobID uuid.UUID) (*Job, error) {
	job, err := s.GetJobForAccount(ctx, accountID, jobID)
	if err != nil {
		return nil, err
	}
	if job.Status.Terminal() {
		return nil, ErrConflict
	}
	now := time.Now().UTC()
	updated, err := s.UpdateJob(ctx, UpdateJobParams{
		JobID: jobID, AccountID: &accountID,
		ExpectStatuses: []jobs.Status{jobs.StatusQueued, jobs.StatusRunning, jobs.StatusAwaitingAudio},
		Patch: JobPatch{
			Status:         Set(jobs.StatusCancelled),
			Stage:          Set("cancelled"),
			Error:          Clear[jobs.JobError](),
			ActiveTaskID:   Clear[string](),
			LeaseExpiresAt: Clear[time.Time](),
			FinishedAt:     SetPtr(&now),
		},
		Event: &NewEvent{Type: "cancelled", Data: map[string]any{"status": "cancelled"}},
	})
	if err != nil {
		return nil, err
	}
	return updated, nil
}

func (s *Store) RetryJob(ctx context.Context, accountID, jobID uuid.UUID, phase jobs.Phase) (*Job, error) {
	job, err := s.GetJobForAccount(ctx, accountID, jobID)
	if err != nil {
		return nil, err
	}
	if job.Status != jobs.StatusFailed && job.Status != jobs.StatusCancelled {
		return nil, ErrConflict
	}
	patch := JobPatch{
		Status:         Set(jobs.StatusQueued),
		Phase:          Set(phase),
		Stage:          Set("queued"),
		Attempt:        Set(job.Attempt + 1),
		AutoRepairs:    Set(0),
		Error:          Clear[jobs.JobError](),
		ActiveTaskID:   Clear[string](),
		LeaseExpiresAt: Clear[time.Time](),
		FinishedAt:     Clear[time.Time](),
	}
	if phase == jobs.PhaseAuthor {
		patch.SourceSHA256 = Clear[string]()
		patch.ScriptSHA256 = Clear[string]()
	}
	updated, err := s.UpdateJob(ctx, UpdateJobParams{
		JobID: jobID, AccountID: &accountID,
		ExpectStatuses: []jobs.Status{jobs.StatusFailed, jobs.StatusCancelled},
		Patch:          patch,
		Event: &NewEvent{
			Type: "retried",
			Data: map[string]any{"attempt": job.Attempt + 1, "phase": string(phase)},
		},
	})
	if err != nil {
		return nil, err
	}
	return updated, nil
}

func (s *Store) ListStaleQueued(ctx context.Context, olderThan time.Duration, limit int) ([]Job, error) {
	if limit <= 0 {
		limit = 100
	}
	rows, err := s.pool.Query(ctx, "SELECT "+jobColumns+` FROM jobs
		WHERE status='queued' AND active_task_id IS NULL
		AND updated_at < now()-($1::int * interval '1 second')
		ORDER BY updated_at LIMIT $2`, int(olderThan/time.Second), limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Job{}
	for rows.Next() {
		job, err := scanJob(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *job)
	}
	return out, rows.Err()
}

func (s *Store) ListExpiredRunning(ctx context.Context, limit int) ([]Job, error) {
	if limit <= 0 {
		limit = 100
	}
	rows, err := s.pool.Query(ctx, "SELECT "+jobColumns+` FROM jobs
		WHERE status='running' AND lease_expires_at IS NOT NULL AND lease_expires_at < now()
		ORDER BY lease_expires_at LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Job{}
	for rows.Next() {
		job, err := scanJob(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *job)
	}
	return out, rows.Err()
}

func (s *Store) MarkInterrupted(ctx context.Context, job *Job) (bool, error) {
	version := job.Version
	now := time.Now().UTC()
	message := "Worker stopped or lost its lease during this task; retry to continue from verified checkpoints"
	_, err := s.UpdateJob(ctx, UpdateJobParams{
		JobID: job.ID, ExpectVersion: &version, ExpectStatuses: []jobs.Status{jobs.StatusRunning},
		Patch: JobPatch{
			Status:         Set(jobs.StatusFailed),
			Stage:          Set("failed"),
			Error:          Set(&jobs.JobError{Code: "INTERRUPTED", Message: message}),
			ActiveTaskID:   Clear[string](),
			LeaseExpiresAt: Clear[time.Time](),
			FinishedAt:     SetPtr(&now),
		},
		Event: &NewEvent{Type: "interrupted", Data: map[string]any{"code": "INTERRUPTED", "message": message}},
	})
	if errors.Is(err, ErrConflict) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}
