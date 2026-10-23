package jobs

import (
	"encoding/json"
	"strings"
)

const AudioIngestedMarker = "audio_ingested"

type Checkpoint struct {
	Stage          string
	SourceSHA256   string
	ScriptSHA256   string
	AudioSHA256    string
	TimelineSHA256 string
	VideoSHA256    string
	Raw            map[string]any
}

func ParseCheckpoint(raw []byte) Checkpoint {
	cp := Checkpoint{Raw: map[string]any{}}
	if len(raw) == 0 {
		return cp
	}
	_ = json.Unmarshal(raw, &cp.Raw)
	cp.Stage = stringValue(cp.Raw["stage"])
	cp.SourceSHA256 = stringValue(cp.Raw["source_sha256"])
	cp.ScriptSHA256 = stringValue(cp.Raw["script_sha256"])
	cp.AudioSHA256 = stringValue(cp.Raw["audio_sha256"])
	cp.TimelineSHA256 = stringValue(cp.Raw["timeline_sha256"])
	cp.VideoSHA256 = stringValue(cp.Raw["video_sha256"])
	return cp
}

func stringValue(v any) string {
	value, _ := v.(string)
	return value
}

func MergeCheckpoint(raw []byte, values map[string]any) []byte {
	merged := map[string]any{}
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &merged)
	}
	for k, v := range values {
		merged[k] = v
	}
	encoded, err := json.Marshal(merged)
	if err != nil {
		return []byte(`{}`)
	}
	return encoded
}

func AudioIngested(raw []byte) bool {
	if len(raw) == 0 {
		return false
	}
	var value map[string]any
	if err := json.Unmarshal(raw, &value); err != nil {
		return false
	}
	ingested, _ := value[AudioIngestedMarker].(bool)
	return ingested
}

func HasAudioInput(input []byte) bool {
	if len(input) == 0 {
		return false
	}
	var value struct {
		Audio *AudioRef `json:"audio"`
	}
	if err := json.Unmarshal(input, &value); err != nil {
		return false
	}
	return value.Audio != nil && value.Audio.AudioObjectKey != "" && value.Audio.WordsObjectKey != ""
}

// QueuedKind decides which task should run for a job currently in queued
// state. Audio import goes through ingest_audio before prepare.
func QueuedKind(phase Phase, input, checkpoint []byte) TaskKind {
	switch phase {
	case PhaseAuthor:
		return TaskAuthor
	case PhaseRender:
		return TaskRender
	case PhasePrepare:
		if HasAudioInput(input) && !AudioIngested(checkpoint) {
			return TaskIngest
		}
		return TaskPrepare
	default:
		return ""
	}
}

func TaskKindFromString(value string) (TaskKind, bool) {
	kind := TaskKind(strings.TrimSpace(value))
	return kind, kind.Valid()
}
