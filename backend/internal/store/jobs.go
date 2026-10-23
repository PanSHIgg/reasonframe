package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/reasonframe/reasonframe/backend/internal/jobs"
)

const jobColumns = `id, account_id, status, phase, stage, priority, input, options,
idempotency_key, request_sha256, attempt, auto_repairs, max_auto_repairs,
source_sha256, script_sha256, checkpoint, error_code, error_message,
active_task_id, lease_expires_at, version, created_at, updated_at, started_at, finished_at`

type rowScanner interface {
	Scan(dest ...any) error
}

func scanJob(row rowScanner) (*Job, error) {
	var (
		j                          Job
		status, phase              string
		input, options, checkpoint []byte
	)
	err := row.Scan(
		&j.ID, &j.AccountID, &status, &phase, &j.Stage, &j.Priority,
		&input, &options, &j.IdempotencyKey, &j.RequestSHA256,
		&j.Attempt, &j.AutoRepairs, &j.MaxAutoRepairs, &j.SourceSHA256,
		&j.ScriptSHA256, &checkpoint, &j.ErrorCode, &j.ErrorMessage,
		&j.ActiveTaskID, &j.LeaseExpiresAt, &j.Version,
		&j.CreatedAt, &j.UpdatedAt, &j.StartedAt, &j.FinishedAt,
	)
	if err != nil {
		return nil, err
	}
	j.Status = jobs.Status(status)
	j.Phase = jobs.Phase(phase)
	j.Input = append(json.RawMessage(nil), input...)
	j.Options = append(json.RawMessage(nil), options...)
	if len(checkpoint) == 0 {
		checkpoint = []byte(`{}`)
	}
	j.Checkpoint = append(json.RawMessage(nil), checkpoint...)
	return &j, nil
}

func (s *Store) GetJob(ctx context.Context, id uuid.UUID) (*Job, error) {
	return s.getJob(ctx, s.pool, "WHERE id=$1", id)
}

func (s *Store) GetJobForAccount(ctx context.Context, accountID, id uuid.UUID) (*Job, error) {
	return s.getJob(ctx, s.pool, "WHERE id=$1 AND account_id=$2", id, accountID)
}

func (s *Store) getJob(ctx context.Context, q interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}, where string, args ...any) (*Job, error) {
	job, err := scanJob(q.QueryRow(ctx, "SELECT "+jobColumns+" FROM jobs "+where, args...))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if err := q.QueryRow(ctx, "SELECT COALESCE(MAX(id),0) FROM job_events WHERE job_id=$1", job.ID).Scan(&job.EventSequence); err != nil {
		return nil, err
	}
	return job, nil
}

func (s *Store) GetJobByKey(ctx context.Context, accountID uuid.UUID, key string) (*Job, error) {
	return s.getJob(ctx, s.pool, "WHERE account_id=$1 AND idempotency_key=$2", accountID, key)
}

type CreateJobParams struct {
	ID             uuid.UUID
	AccountID      uuid.UUID
	Input          json.RawMessage
	Options        json.RawMessage
	IdempotencyKey *string
	RequestSHA256  string
	MaxAutoRepairs int
}

// CreateJob is idempotent when IdempotencyKey is set. The created event and
// pg_notify happen in the same transaction as the insert.
func (s *Store) CreateJob(ctx context.Context, p CreateJobParams) (*Job, bool, error) {
	if p.IdempotencyKey != nil && *p.IdempotencyKey != "" {
		existing, err := s.GetJobByKey(ctx, p.AccountID, *p.IdempotencyKey)
		if err == nil {
			if existing.RequestSHA256 != nil && *existing.RequestSHA256 == p.RequestSHA256 {
				return existing, false, nil
			}
			return nil, false, ErrIdempotencyConflict
		}
		if !errors.Is(err, ErrNotFound) {
			return nil, false, err
		}
	}
	if len(p.Options) == 0 {
		p.Options = []byte(`{}`)
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, false, err
	}
	defer func() { _ = tx.Rollback(context.Background()) }()

	if p.IdempotencyKey != nil && *p.IdempotencyKey == "" {
		p.IdempotencyKey = nil
	}
	_, err = tx.Exec(ctx, `INSERT INTO jobs
		(id, account_id, status, phase, stage, input, options, idempotency_key, request_sha256, max_auto_repairs)
		VALUES ($1,$2,'queued','author','queued',$3,$4,$5,$6,$7)`,
		p.ID, p.AccountID, []byte(p.Input), []byte(p.Options), p.IdempotencyKey, p.RequestSHA256, p.MaxAutoRepairs)
	if err != nil {
		if isUniqueViolation(err) && p.IdempotencyKey != nil {
			_ = tx.Rollback(ctx)
			existing, lookupErr := s.GetJobByKey(ctx, p.AccountID, *p.IdempotencyKey)
			if lookupErr != nil {
				return nil, false, err
			}
			if existing.RequestSHA256 != nil && *existing.RequestSHA256 == p.RequestSHA256 {
				return existing, false, nil
			}
			return nil, false, ErrIdempotencyConflict
		}
		return nil, false, err
	}
	eventID, err := insertEventTx(ctx, tx, p.ID, NewEvent{
		Type: "created", Stage: "queued",
		Data: map[string]any{"status": "queued", "stage": "queued"},
	})
	if err != nil {
		return nil, false, err
	}
	if err := notifyTx(ctx, tx, p.ID, eventID); err != nil {
		return nil, false, err
	}
	job, err := s.getJob(ctx, tx, "WHERE id=$1", p.ID)
	if err != nil {
		return nil, false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, false, err
	}
	return job, true, nil
}

type ListJobsParams struct {
	AccountID       uuid.UUID
	Limit           int
	BeforeCreatedAt *time.Time
	BeforeID        *uuid.UUID
}

func (s *Store) ListJobs(ctx context.Context, p ListJobsParams) ([]Job, error) {
	if p.Limit <= 0 || p.Limit > 1000 {
		p.Limit = 100
	}
	args := []any{p.AccountID}
	where := "WHERE account_id=$1"
	if p.BeforeCreatedAt != nil && p.BeforeID != nil {
		args = append(args, *p.BeforeCreatedAt, *p.BeforeID)
		where += " AND (created_at, id) < ($2, $3)"
	}
	args = append(args, p.Limit)
	rows, err := s.pool.Query(ctx, "SELECT "+jobColumns+" FROM jobs "+where+
		fmt.Sprintf(" ORDER BY created_at DESC, id DESC LIMIT $%d", len(args)), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]Job, 0, p.Limit)
	for rows.Next() {
		job, err := scanJob(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *job)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(out) == 0 {
		return out, nil
	}
	ids := make([]uuid.UUID, len(out))
	index := make(map[uuid.UUID]int, len(out))
	for i := range out {
		ids[i] = out[i].ID
		index[out[i].ID] = i
	}
	seqs, err := s.eventSequences(ctx, ids)
	if err != nil {
		return nil, err
	}
	for id, seq := range seqs {
		if i, ok := index[id]; ok {
			out[i].EventSequence = seq
		}
	}
	return out, nil
}

func (s *Store) eventSequences(ctx context.Context, ids []uuid.UUID) (map[uuid.UUID]int64, error) {
	out := make(map[uuid.UUID]int64, len(ids))
	args, placeholders := uuidArgs(ids, 1)
	rows, err := s.pool.Query(ctx, "SELECT job_id, MAX(id) FROM job_events WHERE job_id IN ("+
		strings.Join(placeholders, ",")+") GROUP BY job_id", args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id uuid.UUID
		var seq int64
		if err := rows.Scan(&id, &seq); err != nil {
			return nil, err
		}
		out[id] = seq
	}
	return out, rows.Err()
}

func uuidArgs(ids []uuid.UUID, start int) ([]any, []string) {
	args := make([]any, 0, len(ids))
	placeholders := make([]string, 0, len(ids))
	for i, id := range ids {
		args = append(args, id)
		placeholders = append(placeholders, fmt.Sprintf("$%d", start+i))
	}
	return args, placeholders
}

type QuotaUsage struct {
	Running  int
	Queued   int
	Awaiting int
}

func (s *Store) QuotaUsage(ctx context.Context, accountID uuid.UUID) (QuotaUsage, error) {
	var usage QuotaUsage
	err := s.pool.QueryRow(ctx, `SELECT
		COUNT(*) FILTER (WHERE status IN ('running','awaiting_audio')),
		COUNT(*) FILTER (WHERE status='queued'),
		COUNT(*) FILTER (WHERE status='awaiting_audio')
		FROM jobs WHERE account_id=$1`, accountID).Scan(&usage.Running, &usage.Queued, &usage.Awaiting)
	return usage, err
}

// JobPatch is a sparse update. Optional fields left unset are not modified.
type JobPatch struct {
	Input          Optional[json.RawMessage]
	Status         Optional[jobs.Status]
	Phase          Optional[jobs.Phase]
	Stage          Optional[string]
	Priority       Optional[int16]
	Attempt        Optional[int]
	AutoRepairs    Optional[int]
	SourceSHA256   Optional[*string]
	ScriptSHA256   Optional[*string]
	Checkpoint     Optional[json.RawMessage]
	Error          Optional[*jobs.JobError]
	ActiveTaskID   Optional[*string]
	LeaseExpiresAt Optional[*time.Time]
	StartedAt      Optional[*time.Time]
	FinishedAt     Optional[*time.Time]
}

type UpdateJobParams struct {
	JobID          uuid.UUID
	AccountID      *uuid.UUID
	ExpectVersion  *int64
	ExpectStatuses []jobs.Status
	ExpectPhases   []jobs.Phase
	ActiveTaskID   *string
	Patch          JobPatch
	Event          *NewEvent
	Artifacts      []ArtifactInput
	Usage          []UsageInput
}

// UpdateJob performs a compare-and-set update and optionally appends events,
// artifacts and usage records in the same transaction. The caller supplies
// ExpectVersion to prevent two workers from advancing the same job.
func (s *Store) UpdateJob(ctx context.Context, p UpdateJobParams) (*Job, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(context.Background()) }()

	args := []any{p.JobID}
	sets := []string{"updated_at=now()", "version=version+1"}
	add := func(template string, value any) {
		args = append(args, value)
		sets = append(sets, fmt.Sprintf(template, len(args)))
	}
	patch := p.Patch
	if patch.Input.Set {
		add("input=$%d", []byte(patch.Input.Value))
	}
	if patch.Status.Set {
		add("status=$%d", string(patch.Status.Value))
	}
	if patch.Phase.Set {
		add("phase=$%d", string(patch.Phase.Value))
	}
	if patch.Stage.Set {
		add("stage=$%d", patch.Stage.Value)
	}
	if patch.Priority.Set {
		add("priority=$%d", patch.Priority.Value)
	}
	if patch.Attempt.Set {
		add("attempt=$%d", patch.Attempt.Value)
	}
	if patch.AutoRepairs.Set {
		add("auto_repairs=$%d", patch.AutoRepairs.Value)
	}
	if patch.SourceSHA256.Set {
		add("source_sha256=$%d", patch.SourceSHA256.Value)
	}
	if patch.ScriptSHA256.Set {
		add("script_sha256=$%d", patch.ScriptSHA256.Value)
	}
	if patch.Checkpoint.Set {
		add("checkpoint=$%d", []byte(patch.Checkpoint.Value))
	}
	if patch.Error.Set {
		if patch.Error.Value == nil {
			sets = append(sets, "error_code=NULL", "error_message=NULL")
		} else {
			add("error_code=$%d", patch.Error.Value.Code)
			add("error_message=$%d", patch.Error.Value.Message)
		}
	}
	if patch.ActiveTaskID.Set {
		add("active_task_id=$%d", patch.ActiveTaskID.Value)
	}
	if patch.LeaseExpiresAt.Set {
		add("lease_expires_at=$%d", patch.LeaseExpiresAt.Value)
	}
	if patch.StartedAt.Set {
		add("started_at=$%d", patch.StartedAt.Value)
	}
	if patch.FinishedAt.Set {
		add("finished_at=$%d", patch.FinishedAt.Value)
	}

	where := []string{"id=$1"}
	if p.AccountID != nil {
		args = append(args, *p.AccountID)
		where = append(where, fmt.Sprintf("account_id=$%d", len(args)))
	}
	if p.ExpectVersion != nil {
		args = append(args, *p.ExpectVersion)
		where = append(where, fmt.Sprintf("version=$%d", len(args)))
	}
	if len(p.ExpectStatuses) > 0 {
		values := make([]string, len(p.ExpectStatuses))
		for i, status := range p.ExpectStatuses {
			values[i] = string(status)
		}
		args = append(args, values)
		where = append(where, fmt.Sprintf("status::text = ANY($%d)", len(args)))
	}
	if len(p.ExpectPhases) > 0 {
		values := make([]string, len(p.ExpectPhases))
		for i, phase := range p.ExpectPhases {
			values[i] = string(phase)
		}
		args = append(args, values)
		where = append(where, fmt.Sprintf("phase::text = ANY($%d)", len(args)))
	}
	if p.ActiveTaskID != nil {
		args = append(args, *p.ActiveTaskID)
		where = append(where, fmt.Sprintf("active_task_id=$%d", len(args)))
	}

	var updatedID uuid.UUID
	err = tx.QueryRow(ctx, "UPDATE jobs SET "+strings.Join(sets, ", ")+" WHERE "+
		strings.Join(where, " AND ")+" RETURNING id", args...).Scan(&updatedID)
	if errors.Is(err, pgx.ErrNoRows) {
		_ = tx.Rollback(ctx)
		if p.AccountID != nil {
			if _, lookupErr := s.GetJobForAccount(ctx, *p.AccountID, p.JobID); errors.Is(lookupErr, ErrNotFound) {
				return nil, ErrNotFound
			}
		}
		return nil, ErrConflict
	}
	if err != nil {
		return nil, err
	}

	lastEventID := int64(0)
	if p.Event != nil {
		id, err := insertEventTx(ctx, tx, p.JobID, *p.Event)
		if err != nil {
			return nil, err
		}
		lastEventID = id
	}
	for _, artifact := range p.Artifacts {
		if err := applyArtifactTx(ctx, tx, p.JobID, artifact); err != nil {
			return nil, err
		}
	}
	if len(p.Usage) > 0 {
		if err := applyUsageTx(ctx, tx, p.JobID, p.Usage); err != nil {
			return nil, err
		}
		totals := map[string]any{"records": len(p.Usage)}
		var inputTokens, outputTokens, audioChars, costMicros int64
		var renderSeconds float64
		for _, usage := range p.Usage {
			inputTokens += usage.InputTokens
			outputTokens += usage.OutputTokens
			audioChars += usage.AudioChars
			renderSeconds += usage.RenderSeconds
			costMicros += usage.CostMicros
		}
		totals["inputTokens"] = inputTokens
		totals["outputTokens"] = outputTokens
		totals["audioChars"] = audioChars
		totals["renderSeconds"] = renderSeconds
		totals["costMicros"] = costMicros
		if _, err := insertEventTx(ctx, tx, p.JobID, NewEvent{Type: "usage.recorded", Data: totals}); err != nil {
			return nil, err
		}
	}
	if p.Event != nil || len(p.Artifacts) > 0 || len(p.Usage) > 0 {
		if err := notifyTx(ctx, tx, p.JobID, lastEventID); err != nil {
			return nil, err
		}
	}
	job, err := s.getJob(ctx, tx, "WHERE id=$1", p.JobID)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return job, nil
}

func applyUsageTx(ctx context.Context, tx pgx.Tx, jobID uuid.UUID, usage []UsageInput) error {
	for _, record := range usage {
		meta := record.Metadata
		if len(meta) == 0 {
			meta = []byte(`{}`)
		}
		provider := record.Provider
		if provider == "" {
			provider = "unknown"
		}
		var model *string
		if record.Model != "" {
			model = &record.Model
		}
		phase := string(record.Phase)
		if phase == "" {
			if err := tx.QueryRow(ctx, `SELECT phase::text FROM jobs WHERE id=$1`, jobID).Scan(&phase); err != nil {
				return err
			}
		}
		_, err := tx.Exec(ctx, `INSERT INTO usage_records
			(job_id, phase, provider, model, input_tokens, output_tokens, audio_chars, render_seconds, cost_micros, metadata)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
			jobID, phase, provider, model, record.InputTokens, record.OutputTokens,
			record.AudioChars, record.RenderSeconds, record.CostMicros, []byte(meta))
		if err != nil {
			return err
		}
	}
	return nil
}
