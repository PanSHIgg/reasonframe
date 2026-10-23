package store

import (
	"context"

	"github.com/google/uuid"
)

func (s *Store) Heartbeat(ctx context.Context, jobID uuid.UUID, taskID string, runID uuid.UUID, leaseSeconds int) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	if _, err := tx.Exec(ctx, `UPDATE job_runs SET heartbeat_at=now() WHERE id=$1 AND status='running'`, runID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE jobs SET lease_expires_at=now()+($1::int * interval '1 second'), updated_at=now()
		WHERE id=$2 AND active_task_id=$3 AND status='running'`, leaseSeconds, jobID, taskID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Store) FinishRun(ctx context.Context, runID uuid.UUID, status string, errorCode *string) error {
	_, err := s.pool.Exec(ctx, `UPDATE job_runs
		SET status=$2, error_code=$3, heartbeat_at=now(), finished_at=now()
		WHERE id=$1`, runID, status, errorCode)
	return err
}

func (s *Store) CountTaskRuns(ctx context.Context, taskID string) (int, error) {
	var count int
	err := s.pool.QueryRow(ctx, `SELECT COUNT(*) FROM job_runs WHERE task_id=$1`, taskID).Scan(&count)
	return count, err
}

func (s *Store) ReapStaleRuns(ctx context.Context, staleAfterSeconds int) (int64, error) {
	tag, err := s.pool.Exec(ctx, `UPDATE job_runs SET status='interrupted', finished_at=now()
		WHERE status='running' AND heartbeat_at < now()-($1::int * interval '1 second')`, staleAfterSeconds)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}
