package auth

import (
	"crypto/sha256"
	"strings"
)

const livePrefix = "rf_live_"

// ParseToken splits rf_live_<key_id>_<secret> into its lookup prefix and the
// secret that is checked against the Argon2id hash.
func ParseToken(token string) (prefix, secret string, ok bool) {
	if !strings.HasPrefix(token, livePrefix) {
		return "", "", false
	}
	rest := strings.TrimPrefix(token, livePrefix)
	keyID, value, found := strings.Cut(rest, "_")
	if !found || keyID == "" || value == "" {
		return "", "", false
	}
	for _, r := range keyID {
		if r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-' {
			continue
		}
		return "", "", false
	}
	return livePrefix + keyID, value, true
}

func bearerValue(header string) (string, bool) {
	scheme, value, found := strings.Cut(strings.TrimSpace(header), " ")
	if !found || !strings.EqualFold(scheme, "Bearer") || strings.TrimSpace(value) == "" {
		return "", false
	}
	return "Bearer " + strings.TrimSpace(value), true
}

func digest(value string) [32]byte { return sha256.Sum256([]byte(value)) }
