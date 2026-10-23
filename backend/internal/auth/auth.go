package auth

import (
	"context"
	"crypto/subtle"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/reasonframe/reasonframe/backend/internal/config"
	"github.com/reasonframe/reasonframe/backend/internal/store"
)

var ErrUnauthorized = errors.New("unauthorized")

type Principal struct {
	AccountID uuid.UUID
	KeyID     *uuid.UUID
	Scopes    []string
	Mode      string
}

type principalKey struct{}

func WithPrincipal(ctx context.Context, principal Principal) context.Context {
	return context.WithValue(ctx, principalKey{}, principal)
}

func FromContext(ctx context.Context) (Principal, bool) {
	principal, ok := ctx.Value(principalKey{}).(Principal)
	return principal, ok
}

type Authenticator struct {
	mode          string
	staticDigest  [32]byte
	staticOn      bool
	staticAccount uuid.UUID
	store         *store.Store
	logger        *slog.Logger
}

func New(cfg config.Config, st *store.Store, staticAccount uuid.UUID, logger *slog.Logger) *Authenticator {
	a := &Authenticator{mode: cfg.Auth.Mode, staticAccount: staticAccount, store: st, logger: logger}
	if cfg.Auth.Mode == "static" && cfg.Auth.StaticKey != "" {
		a.staticOn = true
		a.staticDigest = digest("Bearer " + cfg.Auth.StaticKey)
	}
	return a
}

func (a *Authenticator) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		principal, err := a.Authenticate(r)
		if err != nil {
			if errors.Is(err, ErrUnauthorized) {
				w.Header().Set("WWW-Authenticate", "Bearer")
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusUnauthorized)
				_, _ = w.Write([]byte(`{"error":{"code":"UNAUTHORIZED","message":"Valid service bearer token required"}}`))
				return
			}
			a.logger.Error("API key lookup failed", "error", err)
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusServiceUnavailable)
			_, _ = w.Write([]byte(`{"error":{"code":"SERVICE_UNAVAILABLE","message":"Authentication backend is unavailable"}}`))
			return
		}
		next.ServeHTTP(w, r.WithContext(WithPrincipal(r.Context(), principal)))
	})
}

func (a *Authenticator) Authenticate(r *http.Request) (Principal, error) {
	header := strings.TrimSpace(r.Header.Get("Authorization"))
	if a.mode == "db" {
		if header == "" {
			return Principal{}, ErrUnauthorized
		}
		normalized, ok := bearerValue(header)
		if !ok {
			return Principal{}, ErrUnauthorized
		}
		token := strings.TrimPrefix(normalized, "Bearer ")
		prefix, secret, ok := ParseToken(token)
		if !ok {
			return Principal{}, ErrUnauthorized
		}
		key, err := a.store.GetAPIKeyByPrefix(r.Context(), prefix)
		if errors.Is(err, store.ErrNotFound) {
			return Principal{}, ErrUnauthorized
		}
		if err != nil {
			return Principal{}, err
		}
		if key.RevokedAt != nil || key.ExpiresAt != nil && key.ExpiresAt.Before(time.Now()) {
			return Principal{}, ErrUnauthorized
		}
		if !VerifySecret(string(key.KeyHash), secret) {
			return Principal{}, ErrUnauthorized
		}
		keyID := key.ID
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			_ = a.store.TouchAPIKey(ctx, key.ID)
		}()
		return Principal{AccountID: key.AccountID, KeyID: &keyID, Scopes: key.Scopes, Mode: "db"}, nil
	}
	if !a.staticOn {
		return Principal{AccountID: a.staticAccount, Mode: "static"}, nil
	}
	normalized, ok := bearerValue(header)
	if !ok {
		return Principal{}, ErrUnauthorized
	}
	provided := digest(normalized)
	if subtle.ConstantTimeCompare(provided[:], a.staticDigest[:]) != 1 {
		return Principal{}, ErrUnauthorized
	}
	return Principal{AccountID: a.staticAccount, Mode: "static"}, nil
}

func VerifyStaticHeader(header, expectedKey string) bool {
	if expectedKey == "" {
		return true
	}
	normalized, ok := bearerValue(header)
	if !ok {
		return false
	}
	expected := digest("Bearer " + expectedKey)
	provided := digest(normalized)
	return subtle.ConstantTimeCompare(provided[:], expected[:]) == 1
}
