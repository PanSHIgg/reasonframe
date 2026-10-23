package queue

import (
	"testing"

	"github.com/reasonframe/reasonframe/backend/internal/jobs"
)

func TestPayloadRoundTrip(t *testing.T) {
	payload := NewPayload("00000000-0000-0000-0000-000000000001", jobs.TaskPrepare, 2, 1)
	if payload.Traceparent == "" {
		t.Fatal("expected a generated traceparent")
	}
	task, err := NewTask(payload)
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := ParseTask(task)
	if err != nil {
		t.Fatal(err)
	}
	if parsed != payload {
		t.Fatalf("payload changed: %+v != %+v", parsed, payload)
	}
	if parsed.TaskID() != "00000000-0000-0000-0000-000000000001:prepare:2:1" {
		t.Fatalf("unexpected task id: %s", parsed.TaskID())
	}
	if TaskType(jobs.TaskIngest) != "pipeline:ingest_audio" {
		t.Fatalf("unexpected task type: %s", TaskType(jobs.TaskIngest))
	}
}

func TestParseTaskRejectsInvalidPayload(t *testing.T) {
	if _, err := NewTask(Payload{JobID: "not-a-uuid", Phase: jobs.TaskAuthor}); err == nil {
		t.Fatal("invalid job id accepted")
	}
	if _, err := NewTask(Payload{JobID: "00000000-0000-0000-0000-000000000001", Phase: "bogus"}); err == nil {
		t.Fatal("invalid phase accepted")
	}
}
