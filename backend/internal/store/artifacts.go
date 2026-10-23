package store

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/reasonframe/reasonframe/backend/internal/jobs"
)

const artifactColumns = `a.id, a.job_id, a.name, a.version, a.object_key, a.mime_type, a.size_bytes, a.sha256, a.state, a.is_current, a.source_sha256, a.created_at`

func applyArtifactTx(ctx context.Context, tx pgx.Tx, jobID uuid.UUID, artifact ArtifactInput) error {
	if !jobs.ValidArtifactName(artifact.Name) {
		return fmt.Errorf("invalid artifact name %q", artifact.Name)
	}
	if artifact.ObjectKey == "" {
		return fmt.Errorf("artifact %q has an empty object key", artifact.Name)
	}
	var currentSHA string
	err := tx.QueryRow(ctx, `SELECT sha256 FROM artifacts WHERE job_id=$1 AND name=$2 AND is_current`, jobID, artifact.Name).Scan(&currentSHA)
	if err == nil && currentSHA == artifact.SHA256 {
		return nil
	}
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	var version int
	if err := tx.QueryRow(ctx, `SELECT COALESCE(MAX(version),0)+1 FROM artifacts WHERE job_id=$1 AND name=$2`, jobID, artifact.Name).Scan(&version); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE artifacts SET is_current=false WHERE job_id=$1 AND name=$2 AND is_current`, jobID, artifact.Name); err != nil {
		return err
	}
	mimeType := artifact.MimeType
	if mimeType == "" {
		mimeType = "application/octet-stream"
	}
	_, err = tx.Exec(ctx, `INSERT INTO artifacts
		(id, job_id, name, version, object_key, mime_type, size_bytes, sha256, state, is_current)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'ready',true)`,
		uuid.New(), jobID, artifact.Name, version, artifact.ObjectKey, mimeType, artifact.SizeBytes, artifact.SHA256)
	if err != nil {
		return err
	}
	_, err = insertEventTx(ctx, tx, jobID, NewEvent{
		Type: "artifact.ready",
		Data: map[string]any{"name": artifact.Name, "version": version, "sha256": artifact.SHA256, "sizeBytes": artifact.SizeBytes},
	})
	return err
}

func (s *Store) ListArtifacts(ctx context.Context, accountID, jobID uuid.UUID) ([]Artifact, error) {
	rows, err := s.pool.Query(ctx, `SELECT `+artifactColumns+`
		FROM artifacts a JOIN jobs j ON j.id=a.job_id
		WHERE j.account_id=$1 AND a.job_id=$2 AND a.is_current AND a.state='ready'
		ORDER BY a.name`, accountID, jobID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanArtifacts(rows)
}

func (s *Store) ListArtifactsForJobs(ctx context.Context, accountID uuid.UUID, ids []uuid.UUID) (map[uuid.UUID][]Artifact, error) {
	out := make(map[uuid.UUID][]Artifact, len(ids))
	if len(ids) == 0 {
		return out, nil
	}
	args := []any{accountID}
	placeholders := make([]string, len(ids))
	for i, id := range ids {
		args = append(args, id)
		placeholders[i] = fmt.Sprintf("$%d", i+2)
	}
	rows, err := s.pool.Query(ctx, `SELECT `+artifactColumns+`
		FROM artifacts a JOIN jobs j ON j.id=a.job_id
		WHERE j.account_id=$1 AND a.job_id IN (`+strings.Join(placeholders, ",")+`) AND a.is_current AND a.state='ready'
		ORDER BY a.name`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	artifacts, err := scanArtifacts(rows)
	if err != nil {
		return nil, err
	}
	for _, artifact := range artifacts {
		out[artifact.JobID] = append(out[artifact.JobID], artifact)
	}
	return out, nil
}

func (s *Store) GetArtifact(ctx context.Context, accountID, jobID uuid.UUID, name string) (*Artifact, error) {
	rows, err := s.pool.Query(ctx, `SELECT `+artifactColumns+`
		FROM artifacts a JOIN jobs j ON j.id=a.job_id
		WHERE j.account_id=$1 AND a.job_id=$2 AND a.name=$3 AND a.is_current AND a.state='ready'`, accountID, jobID, name)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	artifacts, err := scanArtifacts(rows)
	if err != nil {
		return nil, err
	}
	if len(artifacts) == 0 {
		return nil, ErrNotFound
	}
	return &artifacts[0], nil
}

func scanArtifacts(rows pgx.Rows) ([]Artifact, error) {
	out := make([]Artifact, 0, 16)
	for rows.Next() {
		var a Artifact
		if err := rows.Scan(&a.ID, &a.JobID, &a.Name, &a.Version, &a.ObjectKey, &a.MimeType, &a.SizeBytes,
			&a.SHA256, &a.State, &a.IsCurrent, &a.SourceSHA256, &a.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}
