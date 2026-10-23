package store

import (
	"context"
	"encoding/json"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func eventData(value any) ([]byte, error) {
	if value == nil {
		return []byte(`{}`), nil
	}
	switch v := value.(type) {
	case json.RawMessage:
		if len(v) == 0 {
			return []byte(`{}`), nil
		}
		if json.Valid(v) {
			return v, nil
		}
		encoded, err := json.Marshal(string(v))
		return encoded, err
	case []byte:
		if len(v) == 0 {
			return []byte(`{}`), nil
		}
		if json.Valid(v) {
			return v, nil
		}
		encoded, err := json.Marshal(string(v))
		return encoded, err
	default:
		return json.Marshal(value)
	}
}

func insertEventTx(ctx context.Context, tx pgx.Tx, jobID uuid.UUID, event NewEvent) (int64, error) {
	data, err := eventData(event.Data)
	if err != nil {
		return 0, err
	}
	createdAt := event.CreatedAt
	if createdAt.IsZero() {
		createdAt = time.Now().UTC()
	}
	var stage, taskID *string
	if event.Stage != "" {
		stage = &event.Stage
	}
	if event.TaskID != "" {
		taskID = &event.TaskID
	}
	var id int64
	err = tx.QueryRow(ctx, `INSERT INTO job_events (job_id, type, stage, task_id, data, created_at)
		VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
		jobID, event.Type, stage, taskID, data, createdAt).Scan(&id)
	return id, err
}

func notifyTx(ctx context.Context, tx pgx.Tx, jobID uuid.UUID, eventID int64) error {
	payload, err := json.Marshal(map[string]any{"jobId": jobID.String(), "id": eventID})
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, "SELECT pg_notify('job_events', $1)", string(payload))
	return err
}

func (s *Store) AppendEvent(ctx context.Context, jobID uuid.UUID, event NewEvent) (int64, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	id, err := insertEventTx(ctx, tx, jobID, event)
	if err != nil {
		return 0, err
	}
	if err := notifyTx(ctx, tx, jobID, id); err != nil {
		return 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return id, nil
}

func (s *Store) ListEvents(ctx context.Context, accountID, jobID uuid.UUID, after int64, limit int) ([]Event, error) {
	if limit <= 0 || limit > 10000 {
		limit = 1000
	}
	rows, err := s.pool.Query(ctx, `SELECT e.id, e.job_id, e.type, COALESCE(e.stage,''), COALESCE(e.task_id,''), e.data, e.created_at
		FROM job_events e JOIN jobs j ON j.id=e.job_id
		WHERE j.account_id=$1 AND e.job_id=$2 AND e.id>$3
		ORDER BY e.id LIMIT $4`, accountID, jobID, after, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]Event, 0, 32)
	for rows.Next() {
		var event Event
		var data []byte
		if err := rows.Scan(&event.ID, &event.JobID, &event.Type, &event.Stage, &event.TaskID, &data, &event.CreatedAt); err != nil {
			return nil, err
		}
		event.Data = append(json.RawMessage(nil), data...)
		if len(event.Data) == 0 {
			event.Data = json.RawMessage(`{}`)
		}
		out = append(out, event)
	}
	return out, rows.Err()
}
