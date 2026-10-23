package store

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type CreateUploadParams struct {
	ID        uuid.UUID
	AccountID uuid.UUID
	Kind      string
	ObjectKey string
	MimeType  string
	SizeBytes int64
	SHA256    string
	ExpiresAt time.Time
}

func (s *Store) CreateUpload(ctx context.Context, p CreateUploadParams) (*Upload, error) {
	var (
		u     Upload
		jobID *uuid.UUID
	)
	err := s.pool.QueryRow(ctx, `INSERT INTO uploads
		(id, account_id, kind, object_key, mime_type, size_bytes, sha256, state, expires_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,'ready',$8)
		RETURNING id, account_id, job_id, kind, object_key, mime_type, size_bytes, sha256, state, expires_at, created_at`,
		p.ID, p.AccountID, p.Kind, p.ObjectKey, p.MimeType, p.SizeBytes, p.SHA256, p.ExpiresAt).
		Scan(&u.ID, &u.AccountID, &jobID, &u.Kind, &u.ObjectKey, &u.MimeType, &u.SizeBytes, &u.SHA256, &u.State, &u.ExpiresAt, &u.CreatedAt)
	if err != nil {
		return nil, err
	}
	u.JobID = jobID
	return &u, nil
}

func (s *Store) GetUpload(ctx context.Context, accountID, id uuid.UUID) (*Upload, error) {
	var u Upload
	err := s.pool.QueryRow(ctx, `SELECT id, account_id, job_id, kind, object_key, mime_type, size_bytes, sha256, state, expires_at, created_at
		FROM uploads WHERE id=$1 AND account_id=$2 AND state='ready' AND expires_at > now()`,
		id, accountID).Scan(&u.ID, &u.AccountID, &u.JobID, &u.Kind, &u.ObjectKey, &u.MimeType, &u.SizeBytes, &u.SHA256, &u.State, &u.ExpiresAt, &u.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &u, nil
}

func (s *Store) AttachUpload(ctx context.Context, accountID, id, jobID uuid.UUID) error {
	tag, err := s.pool.Exec(ctx, `UPDATE uploads SET job_id=$3, state='attached'
		WHERE id=$1 AND account_id=$2 AND state='ready'`, id, accountID, jobID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) DeleteExpiredUploads(ctx context.Context) ([]string, error) {
	rows, err := s.pool.Query(ctx, `DELETE FROM uploads
		WHERE expires_at < now() AND state='ready' AND job_id IS NULL
		RETURNING object_key`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var key string
		if err := rows.Scan(&key); err != nil {
			return nil, err
		}
		out = append(out, key)
	}
	return out, rows.Err()
}
