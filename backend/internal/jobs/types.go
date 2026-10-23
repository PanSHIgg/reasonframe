package jobs

import "time"

type Status string

const (
	StatusQueued        Status = "queued"
	StatusRunning       Status = "running"
	StatusAwaitingAudio Status = "awaiting_audio"
	StatusCompleted     Status = "completed"
	StatusFailed        Status = "failed"
	StatusCancelled     Status = "cancelled"
)

func (s Status) Valid() bool {
	switch s {
	case StatusQueued, StatusRunning, StatusAwaitingAudio, StatusCompleted, StatusFailed, StatusCancelled:
		return true
	}
	return false
}

func (s Status) Terminal() bool {
	return s == StatusCompleted || s == StatusFailed || s == StatusCancelled
}

type Phase string

const (
	PhaseAuthor  Phase = "author"
	PhasePrepare Phase = "prepare"
	PhaseRender  Phase = "render"
	PhaseDone    Phase = "done"
)

func (p Phase) Valid() bool {
	switch p {
	case PhaseAuthor, PhasePrepare, PhaseRender, PhaseDone:
		return true
	}
	return false
}

// TaskKind is the unit of work sent to the AI service. It is deliberately
// separate from Phase: ingest_audio runs while the database phase stays prepare.
type TaskKind string

const (
	TaskAuthor  TaskKind = "author"
	TaskPrepare TaskKind = "prepare"
	TaskRender  TaskKind = "render"
	TaskIngest  TaskKind = "ingest_audio"
)

func (k TaskKind) Valid() bool {
	switch k {
	case TaskAuthor, TaskPrepare, TaskRender, TaskIngest:
		return true
	}
	return false
}

func (k TaskKind) Queue() string {
	switch k {
	case TaskAuthor:
		return "author"
	case TaskRender:
		return "render"
	default:
		return "prepare"
	}
}

func (k TaskKind) DBPhase() Phase {
	switch k {
	case TaskAuthor:
		return PhaseAuthor
	case TaskRender:
		return PhaseRender
	default:
		return PhasePrepare
	}
}

// TimeoutConfig contains configurable phase wall-clock deadlines. A model or
// render task may legitimately take hours; these are safety nets, not quality
// limits. The AI agent and renderer have their own narrower budgets.
type TimeoutConfig struct {
	Author  time.Duration
	Prepare time.Duration
	Render  time.Duration
	Ingest  time.Duration
}

func DefaultTimeouts() TimeoutConfig {
	return TimeoutConfig{
		Author:  6 * time.Hour,
		Prepare: 6 * time.Hour,
		Render:  3 * time.Hour,
		Ingest:  10 * time.Minute,
	}
}

func (k TaskKind) Timeout(overrides ...TimeoutConfig) time.Duration {
	cfg := DefaultTimeouts()
	if len(overrides) > 0 {
		cfg = overrides[0]
	}
	switch k {
	case TaskAuthor:
		return cfg.Author
	case TaskPrepare:
		return cfg.Prepare
	case TaskRender:
		return cfg.Render
	case TaskIngest:
		return cfg.Ingest
	default:
		return 15 * time.Minute
	}
}

func (k TaskKind) MaxRetry() int {
	switch k {
	case TaskAuthor, TaskPrepare:
		return 2
	case TaskRender:
		return 1
	case TaskIngest:
		return 2
	default:
		return 0
	}
}

func InitialStage(k TaskKind) string {
	switch k {
	case TaskAuthor:
		return "authoring"
	case TaskPrepare, TaskIngest:
		return "aligning"
	case TaskRender:
		return "rendering"
	default:
		return "queued"
	}
}

// RecoveryPhase picks the phase a user-visible retry should resume from. The
// AI service reuses verified checkpoints inside the phase, so the safest
// choice is the phase where the job stopped.
func RecoveryPhase(phase Phase) Phase {
	switch phase {
	case PhasePrepare, PhaseRender:
		return phase
	default:
		return PhaseAuthor
	}
}

type JobError struct {
	Code    string
	Message string
}

type ImageInput struct {
	MimeType string `json:"mimeType"`
	Base64   string `json:"base64"`
	UploadID string `json:"uploadId"`
}

type Scope struct {
	Subject          string   `json:"subject"`
	Grade            string   `json:"grade"`
	Topics           []string `json:"topics"`
	AllowedMethods   []string `json:"allowedMethods"`
	ForbiddenMethods []string `json:"forbiddenMethods"`
}

type Options struct {
	Template string `json:"template"`
	FPS      int    `json:"fps"`
	Quality  string `json:"quality"`
	Audio    string `json:"audio"`
}

type JobInput struct {
	Problem     string       `json:"problem"`
	Images      []ImageInput `json:"images"`
	Scope       Scope        `json:"scope"`
	Supplements string       `json:"supplements"`
	Options     Options      `json:"options"`
}

type NormalizedImage struct {
	MimeType  string `json:"mimeType"`
	ObjectKey string `json:"objectKey"`
	SHA256    string `json:"sha256,omitempty"`
	File      string `json:"file,omitempty"`
}

type AudioRef struct {
	AudioObjectKey string `json:"audioObjectKey"`
	WordsObjectKey string `json:"wordsObjectKey"`
	ScriptSHA256   string `json:"scriptSha256"`
}

type NormalizedInput struct {
	Problem     string            `json:"problem"`
	Images      []NormalizedImage `json:"images"`
	Scope       Scope             `json:"scope"`
	Supplements string            `json:"supplements"`
	Options     Options           `json:"options"`
	Audio       *AudioRef         `json:"audio,omitempty"`
}

type PublicInput struct {
	Problem     string        `json:"problem"`
	Images      []PublicImage `json:"images"`
	Scope       Scope         `json:"scope"`
	Supplements string        `json:"supplements"`
	Options     Options       `json:"options"`
}

type PublicImage struct {
	MimeType string `json:"mimeType"`
}

// CodedError carries a stable API error code across packages.
type CodedError struct {
	Code    string
	Message string
}

func (e *CodedError) Error() string { return e.Message }

func Errorf(code, message string) *CodedError {
	return &CodedError{Code: code, Message: message}
}
