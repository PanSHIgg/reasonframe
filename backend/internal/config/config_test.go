package config

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func env(values map[string]string) func(string) string {
	return func(key string) string { return values[key] }
}

func baseEnv() map[string]string {
	return map[string]string{
		"DATABASE_URL":    "postgres://rf:secret@localhost:5432/reasonframe",
		"REDIS_URL":       "redis://localhost:6379/0",
		"AUTH_MODE":       "static",
		"STATIC_API_KEY":  "test-key",
		"S3_ENDPOINT":     "https://minio.example.test",
		"S3_BUCKET":       "reasonframe",
		"S3_ACCESS_KEY":   "access",
		"S3_SECRET_KEY":   "secret",
		"AI_PREPARE_ADDR": "127.0.0.1:50052",
		"AI_AUTHOR_ADDR":  "127.0.0.1:50051",
		"AI_RENDER_ADDR":  "127.0.0.1:50053",
	}
}

func TestLoadDefaultsAndRoleValidation(t *testing.T) {
	cfg, err := LoadFrom(env(baseEnv()))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.MaxImageBytes != 8<<20 || cfg.MaxAudioBytes != 44_000_000 {
		t.Fatalf("unexpected byte limits: %d %d", cfg.MaxImageBytes, cfg.MaxAudioBytes)
	}
	if cfg.AccountMaxActiveJobs != 2 || cfg.AccountMaxQueuedJobs != 10 {
		t.Fatalf("unexpected account limits")
	}
	if cfg.WorkerConcurrencyAuthor != 2 || cfg.WorkerConcurrencyPrepare != 1 || cfg.WorkerConcurrencyRender != 1 {
		t.Fatalf("unexpected worker concurrency")
	}
	if cfg.ReconcileInterval != 30*time.Second || cfg.ShutdownTimeout != 20*time.Second {
		t.Fatalf("unexpected durations")
	}
	if !cfg.S3.UseSSL {
		t.Fatal("https S3 endpoint should enable TLS by default")
	}
	if cfg.AI.Ingest != cfg.AI.Prepare {
		t.Fatal("AI_INGEST_ADDR must default to the prepare address")
	}
	if err := cfg.Validate(RoleAPI); err != nil {
		t.Fatal(err)
	}
	if err := cfg.Validate(RoleWorker); err != nil {
		t.Fatal(err)
	}
	if err := cfg.Validate(RoleMigrate); err != nil {
		t.Fatal(err)
	}
}

func TestLoadRejectsInvalidValues(t *testing.T) {
	values := baseEnv()
	values["MAX_IMAGE_BYTES"] = "-1"
	if _, err := LoadFrom(env(values)); err == nil {
		t.Fatal("expected invalid MAX_IMAGE_BYTES to fail")
	}
	values = baseEnv()
	values["PORT"] = "99999"
	if _, err := LoadFrom(env(values)); err == nil {
		t.Fatal("expected invalid PORT to fail")
	}
	values = baseEnv()
	values["AUTH_MODE"] = "oauth"
	if _, err := LoadFrom(env(values)); err != nil {
		t.Fatal(err)
	} else if err := LoadFromMust(t, values).Validate(RoleAPI); err == nil {
		t.Fatal("expected invalid auth mode to fail validation")
	}
	values = baseEnv()
	values["AI_PREPARE_ADDR"] = "not-an-address"
	cfg, err := LoadFrom(env(values))
	if err != nil {
		t.Fatal(err)
	}
	if err := cfg.Validate(RoleWorker); err == nil {
		t.Fatal("expected invalid AI address to fail")
	}
}

func LoadFromMust(t *testing.T, values map[string]string) Config {
	t.Helper()
	cfg, err := LoadFrom(env(values))
	if err != nil {
		t.Fatal(err)
	}
	return cfg
}

func TestMissingDatabaseURL(t *testing.T) {
	cfg, err := LoadFrom(env(map[string]string{}))
	if err != nil {
		t.Fatal(err)
	}
	if err := cfg.Validate(RoleMigrate); err == nil {
		t.Fatal("expected missing DATABASE_URL validation error")
	}
}

func TestPublicConfigRedactsCredentials(t *testing.T) {
	values := baseEnv()
	values["LLM_ENDPOINT"] = "completions"
	values["LLM_URL"] = "https://llm.example.test/v1"
	values["LLM_MODEL"] = "model-name"
	values["LLM_API_KEY"] = "super-secret-llm-key"
	cfg, err := LoadFrom(env(values))
	if err != nil {
		t.Fatal(err)
	}
	if !cfg.ModelConfigured {
		t.Fatal("expected model to be configured")
	}
	encoded, err := json.Marshal(cfg.Public())
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), "super-secret-llm-key") || strings.Contains(string(encoded), "secret") {
		t.Fatalf("public config leaked a credential: %s", encoded)
	}
	if !strings.Contains(string(encoded), "model-name") {
		t.Fatal("public config should include the model name")
	}
}

func TestPartialModelEnvironmentDoesNotBlockStartup(t *testing.T) {
	values := baseEnv()
	values["LLM_ENDPOINT"] = "responses"
	values["LLM_URL"] = "https://api.openai.com/v1"
	values["LLM_API_KEY"] = ""
	values["LLM_MODEL"] = ""
	cfg, err := LoadFrom(env(values))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ModelConfigured {
		t.Fatal("model should not be configured without key and model name")
	}
	if err := cfg.Validate(RoleAPI); err != nil {
		t.Fatal(err)
	}
}
