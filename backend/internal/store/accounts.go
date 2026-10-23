package store

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

const DefaultAccountSlug = "default"

var DefaultAccountID = uuid.MustParse("00000000-0000-0000-0000-000000000001")

// EnsureDefaultAccount returns the account used by AUTH_MODE=static. The
// migration seeds the fixed UUID; this also repairs an installation where the
// slug already exists with another id.
func (s *Store) EnsureDefaultAccount(ctx context.Context) (uuid.UUID, error) {
	_, err := s.pool.Exec(ctx, `INSERT INTO accounts (id, slug, name)
		VALUES ($1, $2, 'Default Account') ON CONFLICT DO NOTHING`, DefaultAccountID, DefaultAccountSlug)
	if err != nil {
		return uuid.Nil, err
	}
	var id uuid.UUID
	if err := s.pool.QueryRow(ctx, `SELECT id FROM accounts WHERE slug=$1`, DefaultAccountSlug).Scan(&id); err != nil {
		return uuid.Nil, err
	}
	return id, nil
}

func (s *Store) GetAccount(ctx context.Context, id uuid.UUID) (*Account, error) {
	var account Account
	err := s.pool.QueryRow(ctx, `SELECT id, slug, name, created_at FROM accounts WHERE id=$1`, id).
		Scan(&account.ID, &account.Slug, &account.Name, &account.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &account, nil
}

func (s *Store) GetAPIKeyByPrefix(ctx context.Context, prefix string) (*APIKey, error) {
	var (
		key    APIKey
		hash   []byte
		scopes []string
	)
	err := s.pool.QueryRow(ctx, `SELECT id, account_id, name, key_prefix, key_hash, scopes, expires_at, revoked_at, last_used_at, created_at
		FROM api_keys WHERE key_prefix=$1`, prefix).
		Scan(&key.ID, &key.AccountID, &key.Name, &key.KeyPrefix, &hash, &scopes,
			&key.ExpiresAt, &key.RevokedAt, &key.LastUsedAt, &key.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	key.KeyHash = append([]byte(nil), hash...)
	key.Scopes = scopes
	return &key, nil
}

func (s *Store) TouchAPIKey(ctx context.Context, id uuid.UUID) error {
	_, err := s.pool.Exec(ctx, `UPDATE api_keys SET last_used_at=now() WHERE id=$1`, id)
	return err
}

func (s *Store) CreateAPIKey(ctx context.Context, accountID uuid.UUID, name, prefix string, hash []byte, scopes []string, expiresAt *time.Time) (*APIKey, error) {
	var key APIKey
	var storedHash []byte
	err := s.pool.QueryRow(ctx, `INSERT INTO api_keys (id, account_id, name, key_prefix, key_hash, scopes, expires_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7)
		RETURNING id, account_id, name, key_prefix, key_hash, scopes, expires_at, revoked_at, last_used_at, created_at`,
		uuid.New(), accountID, name, prefix, hash, scopes, expiresAt).
		Scan(&key.ID, &key.AccountID, &key.Name, &key.KeyPrefix, &storedHash, &key.Scopes,
			&key.ExpiresAt, &key.RevokedAt, &key.LastUsedAt, &key.CreatedAt)
	if err != nil {
		return nil, err
	}
	key.KeyHash = append([]byte(nil), storedHash...)
	return &key, nil
}
