package config

import (
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/reasonframe/reasonframe/backend/internal/jobs"
)

type Role string

const (
	RoleAPI        Role = "api"
	RoleWorker     Role = "worker"
	RoleReconciler Role = "reconciler"
	RoleMigrate    Role = "migrate"
)

type S3 struct {
	Endpoint  string
	Region    string
	Bucket    string
	AccessKey string
	SecretKey string
	UseSSL    bool
}

type AI struct {
	Author        string
	Prepare       string
	Render        string
	Ingest        string
	InternalToken string
}

type Auth struct {
	Mode      string
	StaticKey string
}

type Model struct {
	Endpoint         string
	URL              string
	Model            string
	ContextWindow    int
	MaxTokens        int
	RequestTimeoutMs int
	MaxAttempts      int
	RetryDelayMs     int
	ThinkingLevel    string
}

type Agent struct {
	TimeoutMs               int
	MaxAttempts             int
	MaxToolCalls            int
	MaxTurns                int
	VisualMaxRepairAttempts int
}

type Config struct {
	HTTPAddr      string
	DatabaseURL   string
	RedisURL      string
	S3            S3
	AI            AI
	Auth          Auth
	PublicBaseURL string

	MaxImageBytes        int64
	MaxAudioBytes        int64
	AccountMaxActiveJobs int
	AccountMaxQueuedJobs int

	WorkerConcurrencyAuthor  int
	WorkerConcurrencyPrepare int
	WorkerConcurrencyRender  int

	ReconcileInterval time.Duration
	ShutdownTimeout   time.Duration
	OTelEndpoint      string

	Model           Model
	ModelConfigured bool
	TTSConfigured   bool
	RenderWorkers   int
	RenderTimeout   time.Duration
	RenderBitrate   string
	AgentConfig     Agent
	TaskTimeouts    jobs.TimeoutConfig
}

type PublicModel struct {
	Endpoint         string `json:"endpoint"`
	URL              string `json:"url"`
	Model            string `json:"model"`
	ContextWindow    int    `json:"contextWindow"`
	MaxTokens        int    `json:"maxTokens"`
	RequestTimeoutMs int    `json:"requestTimeoutMs"`
	MaxAttempts      int    `json:"maxAttempts"`
	RetryDelayMs     int    `json:"retryDelayMs"`
	ThinkingLevel    string `json:"thinkingLevel"`
}

type PublicAgent struct {
	TimeoutMs               int `json:"timeoutMs"`
	MaxAttempts             int `json:"maxAttempts"`
	MaxToolCalls            int `json:"maxToolCalls"`
	MaxTurns                int `json:"maxTurns"`
	VisualMaxRepairAttempts int `json:"visualMaxRepairAttempts"`
}

type PublicRender struct {
	Workers   int    `json:"workers"`
	TimeoutMs int64  `json:"timeoutMs"`
	Bitrate   string `json:"bitrate"`
}

type PublicControlPlane struct {
	AuthMode             string   `json:"authMode"`
	AuthEnabled          bool     `json:"authEnabled"`
	PublicBaseURL        string   `json:"publicBaseUrl"`
	MaxImageBytes        int64    `json:"maxImageBytes"`
	MaxAudioBytes        int64    `json:"maxAudioBytes"`
	AccountMaxActiveJobs int      `json:"accountMaxActiveJobs"`
	AccountMaxQueuedJobs int      `json:"accountMaxQueuedJobs"`
	Queues               []string `json:"queues"`
	ReconcileIntervalSec int64    `json:"reconcileIntervalSec"`
}

type PublicConfig struct {
	Model         *PublicModel       `json:"model"`
	Agent         PublicAgent        `json:"agent"`
	Render        PublicRender       `json:"render"`
	TTSConfigured bool               `json:"ttsConfigured"`
	Concurrency   int                `json:"concurrency"`
	Resolution    [2]int             `json:"resolution"`
	EndpointTypes []string           `json:"endpointTypes"`
	ControlPlane  PublicControlPlane `json:"controlPlane"`
}

func Load() (Config, error) {
	return LoadFrom(os.Getenv)
}

func LoadFrom(get func(string) string) (Config, error) {
	c := Config{
		DatabaseURL:          strings.TrimSpace(get("DATABASE_URL")),
		RedisURL:             strings.TrimSpace(get("REDIS_URL")),
		PublicBaseURL:        strings.TrimRight(strings.TrimSpace(get("PUBLIC_BASE_URL")), "/"),
		OTelEndpoint:         strings.TrimSpace(get("OTEL_EXPORTER_OTLP_ENDPOINT")),
		MaxImageBytes:        8 << 20,
		MaxAudioBytes:        44_000_000,
		AccountMaxActiveJobs: 2,
		AccountMaxQueuedJobs: 10,
		RenderWorkers:        2,
		RenderTimeout:        30 * time.Minute,
		RenderBitrate:        "8M",
	}
	c.HTTPAddr = strings.TrimSpace(get("API_ADDR"))
	if c.HTTPAddr == "" {
		host := strings.TrimSpace(get("HOST"))
		if host == "" {
			host = "127.0.0.1"
		}
		port, err := parseInt(get, "PORT", 4310, 0, 65535)
		if err != nil {
			return Config{}, err
		}
		c.HTTPAddr = net.JoinHostPort(host, strconv.Itoa(port))
	}

	region := strings.TrimSpace(get("S3_REGION"))
	if region == "" {
		region = "us-east-1"
	}
	endpoint := strings.TrimSpace(get("S3_ENDPOINT"))
	sslDefault := false
	if strings.HasPrefix(endpoint, "https://") {
		sslDefault = true
		endpoint = strings.TrimPrefix(endpoint, "https://")
	} else if strings.HasPrefix(endpoint, "http://") {
		endpoint = strings.TrimPrefix(endpoint, "http://")
	}
	endpoint = strings.TrimRight(endpoint, "/")
	useSSL, err := parseBool(get, "S3_USE_SSL", sslDefault)
	if err != nil {
		return Config{}, err
	}
	c.S3 = S3{
		Endpoint:  endpoint,
		Region:    region,
		Bucket:    strings.TrimSpace(get("S3_BUCKET")),
		AccessKey: strings.TrimSpace(get("S3_ACCESS_KEY")),
		SecretKey: get("S3_SECRET_KEY"),
		UseSSL:    useSSL,
	}

	mode := strings.ToLower(strings.TrimSpace(get("AUTH_MODE")))
	if mode == "" {
		mode = "static"
	}
	c.Auth = Auth{Mode: mode, StaticKey: get("STATIC_API_KEY")}

	if err := parseInto(&c.MaxImageBytes, get("MAX_IMAGE_BYTES"), 1, 512<<20, "MAX_IMAGE_BYTES"); err != nil {
		return Config{}, err
	}
	if err := parseInto(&c.MaxAudioBytes, get("MAX_AUDIO_BYTES"), 1, 512<<20, "MAX_AUDIO_BYTES"); err != nil {
		return Config{}, err
	}
	if c.AccountMaxActiveJobs, err = parseInt(get, "ACCOUNT_MAX_ACTIVE_JOBS", 2, 1, 1000); err != nil {
		return Config{}, err
	}
	if c.AccountMaxQueuedJobs, err = parseInt(get, "ACCOUNT_MAX_QUEUED_JOBS", 10, 0, 10000); err != nil {
		return Config{}, err
	}
	if c.WorkerConcurrencyAuthor, err = parseInt(get, "WORKER_CONCURRENCY_AUTHOR", 2, 1, 256); err != nil {
		return Config{}, err
	}
	if c.WorkerConcurrencyPrepare, err = parseInt(get, "WORKER_CONCURRENCY_PREPARE", 1, 1, 256); err != nil {
		return Config{}, err
	}
	if c.WorkerConcurrencyRender, err = parseInt(get, "WORKER_CONCURRENCY_RENDER", 1, 1, 256); err != nil {
		return Config{}, err
	}
	if c.ReconcileInterval, err = parseDuration(get, "RECONCILE_INTERVAL", 30*time.Second, time.Second, time.Hour); err != nil {
		return Config{}, err
	}
	if c.ShutdownTimeout, err = parseDuration(get, "SHUTDOWN_TIMEOUT", 20*time.Second, time.Second, 5*time.Minute); err != nil {
		return Config{}, err
	}

	c.AI = AI{
		Author:        strings.TrimSpace(get("AI_AUTHOR_ADDR")),
		Prepare:       strings.TrimSpace(get("AI_PREPARE_ADDR")),
		Render:        strings.TrimSpace(get("AI_RENDER_ADDR")),
		InternalToken: firstNonEmpty(strings.TrimSpace(get("AI_INTERNAL_TOKEN")), strings.TrimSpace(get("INTERNAL_TOKEN"))),
	}
	c.AI.Ingest = strings.TrimSpace(get("AI_INGEST_ADDR"))
	if c.AI.Ingest == "" {
		c.AI.Ingest = c.AI.Prepare
	}

	endpointType := strings.ToLower(strings.TrimSpace(get("LLM_ENDPOINT")))
	modelURL := strings.TrimSpace(get("LLM_URL"))
	modelName := strings.TrimSpace(get("LLM_MODEL"))
	modelKey := strings.TrimSpace(get("LLM_API_KEY"))
	if endpointType != "" && modelURL != "" && modelName != "" && modelKey != "" {
		switch endpointType {
		case "responses", "openai-responses":
			endpointType = "responses"
		case "completions", "openai-completions":
			endpointType = "completions"
		case "messages", "anthropic-messages":
			endpointType = "messages"
		default:
			return Config{}, errors.New("LLM_ENDPOINT must be responses, completions, or messages")
		}
		if err := validateHTTPURL("LLM_URL", modelURL); err != nil {
			return Config{}, err
		}
		c.Model = Model{
			Endpoint:         endpointType,
			URL:              modelURL,
			Model:            modelName,
			ContextWindow:    128000,
			MaxTokens:        8192,
			RequestTimeoutMs: 120000,
			MaxAttempts:      3,
			RetryDelayMs:     1000,
			ThinkingLevel:    "off",
		}
		if c.Model.ContextWindow, err = parseInt(get, "LLM_CONTEXT_WINDOW", 128000, 8192, 2_000_000); err != nil {
			return Config{}, err
		}
		if c.Model.MaxTokens, err = parseInt(get, "LLM_MAX_TOKENS", 8192, 1024, 524288); err != nil {
			return Config{}, err
		}
		if c.Model.MaxTokens >= c.Model.ContextWindow {
			return Config{}, errors.New("LLM_MAX_TOKENS must be less than LLM_CONTEXT_WINDOW")
		}
		if c.Model.RequestTimeoutMs, err = parseInt(get, "LLM_REQUEST_TIMEOUT_MS", 120000, 100, 3_600_000); err != nil {
			return Config{}, err
		}
		if c.Model.MaxAttempts, err = parseInt(get, "LLM_MAX_ATTEMPTS", 3, 1, 10); err != nil {
			return Config{}, err
		}
		if c.Model.RetryDelayMs, err = parseInt(get, "LLM_RETRY_DELAY_MS", 1000, 0, 60_000); err != nil {
			return Config{}, err
		}
		if level := strings.TrimSpace(get("LLM_THINKING_LEVEL")); level != "" {
			switch level {
			case "off", "minimal", "low", "medium", "high", "xhigh":
				c.Model.ThinkingLevel = level
			default:
				return Config{}, errors.New("LLM_THINKING_LEVEL must be off, minimal, low, medium, high, or xhigh")
			}
		}
		c.ModelConfigured = true
	} else if modelName != "" && modelKey != "" {
		return Config{}, errors.New("LLM_ENDPOINT, LLM_URL, LLM_API_KEY and LLM_MODEL must all be set together")
	}
	c.TTSConfigured = strings.TrimSpace(get("TTS_PROVIDER")) != "" || strings.TrimSpace(get("TTS_URL")) != "" || strings.TrimSpace(get("TTS_VOICE")) != ""

	c.AgentConfig = Agent{TimeoutMs: 600000, MaxAttempts: 3, MaxToolCalls: 80, MaxTurns: 40, VisualMaxRepairAttempts: 1}
	if c.AgentConfig.TimeoutMs, err = parseInt(get, "REASONFRAME_AGENT_TIMEOUT_MS", 3_600_000, 1000, 21_600_000); err != nil {
		return Config{}, err
	}
	if c.AgentConfig.MaxAttempts, err = parseInt(get, "REASONFRAME_AGENT_MAX_ATTEMPTS", 3, 1, 10); err != nil {
		return Config{}, err
	}
	if c.AgentConfig.MaxToolCalls, err = parseInt(get, "REASONFRAME_AGENT_MAX_TOOL_CALLS", 80, 1, 1000); err != nil {
		return Config{}, err
	}
	if c.AgentConfig.MaxTurns, err = parseInt(get, "REASONFRAME_AGENT_MAX_TURNS", 40, 1, 1000); err != nil {
		return Config{}, err
	}
	if c.AgentConfig.VisualMaxRepairAttempts, err = parseInt(get, "REASONFRAME_VISUAL_MAX_REPAIR_ATTEMPTS", 1, 0, 10); err != nil {
		return Config{}, err
	}
	if c.RenderWorkers, err = parseInt(get, "REASONFRAME_RENDER_WORKERS", 2, 1, 8); err != nil {
		return Config{}, err
	}
	renderTimeoutMs, err := parseInt(get, "REASONFRAME_RENDER_TIMEOUT_MS", 1_800_000, 1000, 7_200_000)
	if err != nil {
		return Config{}, err
	}
	c.RenderTimeout = time.Duration(renderTimeoutMs) * time.Millisecond

	c.TaskTimeouts = jobs.DefaultTimeouts()
	timeoutEnv := []struct {
		name string
		dst  *time.Duration
	}{
		{"TASK_TIMEOUT_AUTHOR_MS", &c.TaskTimeouts.Author},
		{"TASK_TIMEOUT_PREPARE_MS", &c.TaskTimeouts.Prepare},
		{"TASK_TIMEOUT_RENDER_MS", &c.TaskTimeouts.Render},
		{"TASK_TIMEOUT_INGEST_MS", &c.TaskTimeouts.Ingest},
	}
	for _, item := range timeoutEnv {
		ms, err := parseInt(get, item.name, int(item.dst.Milliseconds()), 1000, 86_400_000)
		if err != nil {
			return Config{}, err
		}
		*item.dst = time.Duration(ms) * time.Millisecond
	}
	if bitrate := strings.TrimSpace(get("REASONFRAME_RENDER_BITRATE")); bitrate != "" {
		c.RenderBitrate = bitrate
	}

	if c.PublicBaseURL != "" {
		if err := validateHTTPURL("PUBLIC_BASE_URL", c.PublicBaseURL); err != nil {
			return Config{}, err
		}
	}
	if c.OTelEndpoint != "" {
		if err := validateHTTPURL("OTEL_EXPORTER_OTLP_ENDPOINT", c.OTelEndpoint); err != nil {
			return Config{}, err
		}
	}
	return c, nil
}

func (c Config) Validate(role Role) error {
	if c.DatabaseURL == "" {
		return errors.New("DATABASE_URL is required")
	}
	u, err := url.Parse(c.DatabaseURL)
	if err != nil || (u.Scheme != "postgres" && u.Scheme != "postgresql") || u.Host == "" {
		return errors.New("DATABASE_URL must be a postgres:// or postgresql:// URL")
	}
	if c.Auth.Mode != "static" && c.Auth.Mode != "db" {
		return errors.New("AUTH_MODE must be static or db")
	}
	switch role {
	case RoleMigrate:
		return nil
	case RoleAPI:
		if err := c.validateRedis(); err != nil {
			return err
		}
		if c.S3.Endpoint == "" || c.S3.Bucket == "" || c.S3.AccessKey == "" || c.S3.SecretKey == "" {
			return errors.New("S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY and S3_SECRET_KEY are required for the API")
		}
		for _, addr := range []string{c.AI.Author, c.AI.Prepare, c.AI.Render} {
			if err := validateAIAddr(addr); err != nil {
				return err
			}
		}
	case RoleWorker:
		if err := c.validateRedis(); err != nil {
			return err
		}
		if c.AI.Author == "" || c.AI.Prepare == "" || c.AI.Render == "" {
			return errors.New("AI_AUTHOR_ADDR, AI_PREPARE_ADDR and AI_RENDER_ADDR are required for the worker")
		}
		for _, addr := range []string{c.AI.Author, c.AI.Prepare, c.AI.Render, c.AI.Ingest} {
			if err := validateAIAddr(addr); err != nil {
				return err
			}
		}
	case RoleReconciler:
		if err := c.validateRedis(); err != nil {
			return err
		}
	default:
		return fmt.Errorf("unknown role %q", role)
	}
	return nil
}

func (c Config) validateRedis() error {
	if c.RedisURL == "" {
		return errors.New("REDIS_URL is required")
	}
	u, err := url.Parse(c.RedisURL)
	if err != nil || (u.Scheme != "redis" && u.Scheme != "rediss") || u.Host == "" {
		return errors.New("REDIS_URL must be a redis:// or rediss:// URL")
	}
	return nil
}

func (c Config) AIAddressFor(kind string) string {
	switch kind {
	case "author":
		return c.AI.Author
	case "prepare":
		return c.AI.Prepare
	case "render":
		return c.AI.Render
	case "ingest_audio":
		return c.AI.Ingest
	default:
		return ""
	}
}

func (c Config) Public() PublicConfig {
	var model *PublicModel
	if c.ModelConfigured {
		m := c.Model
		model = &PublicModel{
			Endpoint: m.Endpoint, URL: m.URL, Model: m.Model,
			ContextWindow: m.ContextWindow, MaxTokens: m.MaxTokens,
			RequestTimeoutMs: m.RequestTimeoutMs, MaxAttempts: m.MaxAttempts,
			RetryDelayMs: m.RetryDelayMs, ThinkingLevel: m.ThinkingLevel,
		}
	}
	authEnabled := c.Auth.Mode == "db" || (c.Auth.Mode == "static" && c.Auth.StaticKey != "")
	return PublicConfig{
		Model: model,
		Agent: PublicAgent{
			TimeoutMs: c.AgentConfig.TimeoutMs, MaxAttempts: c.AgentConfig.MaxAttempts,
			MaxToolCalls: c.AgentConfig.MaxToolCalls, MaxTurns: c.AgentConfig.MaxTurns,
			VisualMaxRepairAttempts: c.AgentConfig.VisualMaxRepairAttempts,
		},
		Render: PublicRender{
			Workers: c.RenderWorkers, TimeoutMs: c.RenderTimeout.Milliseconds(), Bitrate: c.RenderBitrate,
		},
		TTSConfigured: c.TTSConfigured,
		Concurrency:   c.WorkerConcurrencyAuthor,
		Resolution:    [2]int{1920, 1080},
		EndpointTypes: []string{"responses", "completions", "messages"},
		ControlPlane: PublicControlPlane{
			AuthMode: c.Auth.Mode, AuthEnabled: authEnabled, PublicBaseURL: c.PublicBaseURL,
			MaxImageBytes: c.MaxImageBytes, MaxAudioBytes: c.MaxAudioBytes,
			AccountMaxActiveJobs: c.AccountMaxActiveJobs, AccountMaxQueuedJobs: c.AccountMaxQueuedJobs,
			Queues:               []string{"author", "prepare", "render"},
			ReconcileIntervalSec: int64(c.ReconcileInterval / time.Second),
		},
	}
}

func parseInt(get func(string) string, name string, def, min, max int) (int, error) {
	raw := strings.TrimSpace(get(name))
	if raw == "" {
		return def, nil
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n < min || n > max {
		return 0, fmt.Errorf("%s must be an integer in %d..%d", name, min, max)
	}
	return n, nil
}

func parseInto(dst *int64, raw string, min, max int64, name string) error {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil
	}
	n, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || n < min || n > max {
		return fmt.Errorf("%s must be an integer in %d..%d", name, min, max)
	}
	*dst = n
	return nil
}

func parseBool(get func(string) string, name string, def bool) (bool, error) {
	raw := strings.TrimSpace(get(name))
	if raw == "" {
		return def, nil
	}
	switch strings.ToLower(raw) {
	case "1", "true", "yes", "on":
		return true, nil
	case "0", "false", "no", "off":
		return false, nil
	default:
		return false, fmt.Errorf("%s must be true or false", name)
	}
}

func parseDuration(get func(string) string, name string, def, min, max time.Duration) (time.Duration, error) {
	raw := strings.TrimSpace(get(name))
	if raw == "" {
		return def, nil
	}
	d, err := time.ParseDuration(raw)
	if err != nil {
		if seconds, convErr := strconv.Atoi(raw); convErr == nil {
			d = time.Duration(seconds) * time.Second
			err = nil
		}
	}
	if err != nil || d < min || d > max {
		return 0, fmt.Errorf("%s must be a duration in %s..%s", name, min, max)
	}
	return d, nil
}

func validateHTTPURL(name, raw string) error {
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return fmt.Errorf("%s must be an http(s) URL", name)
	}
	return nil
}

func validateAIAddr(addr string) error {
	if addr == "" {
		return nil
	}
	target := addr
	for _, prefix := range []string{"dns:///", "ipv4:///", "ipv6:///"} {
		if strings.HasPrefix(target, prefix) {
			target = strings.TrimPrefix(target, prefix)
			break
		}
	}
	host, port, err := net.SplitHostPort(target)
	if err != nil || host == "" || port == "" {
		return fmt.Errorf("%s must be host:port (optionally dns:///host:port)", addr)
	}
	if _, err := strconv.Atoi(port); err != nil {
		return fmt.Errorf("%s has a non-numeric port", addr)
	}
	return nil
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}
