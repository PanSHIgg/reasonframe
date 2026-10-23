package worker

import (
	"encoding/json"
	"testing"

	"github.com/google/uuid"
	"github.com/reasonframe/reasonframe/backend/internal/jobs"
	"github.com/reasonframe/reasonframe/backend/internal/store"
)

func TestAISpecMovesNestedAudioToTopLevel(t *testing.T) {
	job := &store.Job{ID: uuid.New(), Attempt: 1, AutoRepairs: 1}
	job.Input, _ = json.Marshal(jobs.NormalizedInput{
		Problem: "problem",
		Scope:   jobs.Scope{Subject: "math", Grade: "高中"},
		Options: jobs.Options{Template: "auto", FPS: 24, Quality: "looks", Audio: "provided"},
		Audio:   &jobs.AudioRef{AudioObjectKey: "jobs/x/input/audio.mp3", WordsObjectKey: "jobs/x/input/words.json", ScriptSHA256: "abc"},
	})
	raw, err := aiSpec(job)
	if err != nil {
		t.Fatal(err)
	}
	var payload struct {
		SchemaVersion   int               `json:"schemaVersion"`
		JobID           string            `json:"jobId"`
		Input           map[string]any    `json:"input"`
		Audio           map[string]string `json:"audio"`
		Words           map[string]string `json:"words"`
		ArtifactVersion string            `json:"artifactVersion"`
		Repair          bool              `json:"repair"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		t.Fatal(err)
	}
	if payload.SchemaVersion != 1 || payload.JobID != job.ID.String() || !payload.Repair || payload.ArtifactVersion != "2" {
		t.Fatalf("unexpected spec envelope: %+v", payload)
	}
	if _, ok := payload.Input["audio"]; ok {
		t.Fatal("input must not contain nested audio")
	}
	if payload.Audio["objectKey"] != "jobs/x/input/audio.mp3" || payload.Words["objectKey"] != "jobs/x/input/words.json" {
		t.Fatalf("audio refs not promoted: %+v %+v", payload.Audio, payload.Words)
	}
}
