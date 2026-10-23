package auth

import "testing"

func TestArgon2RoundTrip(t *testing.T) {
	hash, err := HashSecret("correct horse battery staple")
	if err != nil {
		t.Fatal(err)
	}
	if hash[:10] != "$argon2id$" {
		t.Fatalf("unexpected hash format: %s", hash)
	}
	if !VerifySecret(hash, "correct horse battery staple") {
		t.Fatal("expected secret to verify")
	}
	if VerifySecret(hash, "wrong") {
		t.Fatal("wrong secret verified")
	}
	if VerifySecret("not-a-hash", "x") {
		t.Fatal("malformed hash verified")
	}
}

func TestParseToken(t *testing.T) {
	prefix, secret, ok := ParseToken("rf_live_123e4567-e89b-12d3-a456-426614174000_abcDEF123")
	if !ok || prefix != "rf_live_123e4567-e89b-12d3-a456-426614174000" || secret != "abcDEF123" {
		t.Fatalf("unexpected parse result: %q %q %v", prefix, secret, ok)
	}
	for _, token := range []string{"", "rf_live_", "rf_live_only", "other_live_id_secret", "rf_live_bad id_secret"} {
		if _, _, ok := ParseToken(token); ok {
			t.Fatalf("token %q should be rejected", token)
		}
	}
}

func TestStaticHeaderVerification(t *testing.T) {
	if !VerifyStaticHeader("Bearer secret", "secret") {
		t.Fatal("expected matching header")
	}
	if !VerifyStaticHeader("bearer secret", "secret") {
		t.Fatal("bearer scheme should be case-insensitive")
	}
	if VerifyStaticHeader("Bearer wrong", "secret") {
		t.Fatal("mismatched header accepted")
	}
	if VerifyStaticHeader("", "secret") {
		t.Fatal("missing header accepted")
	}
	if !VerifyStaticHeader("", "") {
		t.Fatal("auth-disabled mode should accept any header")
	}
}
