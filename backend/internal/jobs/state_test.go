package jobs

import (
	"encoding/json"
	"testing"
)

func TestPlanResultAuthorAndPrepare(t *testing.T) {
	plan := PlanResult(TaskAuthor, "completed", "", false, 0, 1, 1)
	if plan.Action != ActionAdvance || plan.Phase != PhasePrepare || plan.NextTask != TaskPrepare || plan.EventType != "source.approved" {
		t.Fatalf("unexpected author advance: %+v", plan)
	}
	plan = PlanResult(TaskAuthor, "failed", "REVIEW_REJECTED", true, 0, 1, 1)
	if plan.Action != ActionFail || plan.Status != StatusFailed {
		t.Fatalf("author failure must not auto-repair: %+v", plan)
	}
	plan = PlanResult(TaskPrepare, "awaiting_audio", "", false, 0, 1, 1)
	if plan.Action != ActionAwaitAudio || plan.Status != StatusAwaitingAudio || plan.EventType != "awaiting_audio" {
		t.Fatalf("unexpected awaiting audio: %+v", plan)
	}
	plan = PlanResult(TaskPrepare, "failed", "VISUAL_CHECK_FAILED", true, 0, 1, 1)
	if plan.Action != ActionRepair || plan.Phase != PhasePrepare || plan.NextTask != TaskPrepare {
		t.Fatalf("expected video repair: %+v", plan)
	}
	plan = PlanResult(TaskPrepare, "failed", "VISUAL_CHECK_FAILED", true, 1, 1, 1)
	if plan.Action != ActionFail {
		t.Fatalf("repair budget exhausted: %+v", plan)
	}
	plan = PlanResult(TaskPrepare, "failed", "VIDEO_QUALITY_GATE_FAILED", true, 0, 2, 1)
	if plan.Action != ActionRepair || plan.Phase != PhasePrepare || plan.NextTask != TaskPrepare {
		t.Fatalf("video-only rejection must stay in the video loop: %+v", plan)
	}
	plan = PlanResult(TaskPrepare, "failed", "ANSWER_REVISION_REQUIRED", true, 0, 2, 1)
	if plan.Action != ActionRepair || plan.Phase != PhaseAuthor || plan.NextTask != TaskAuthor {
		t.Fatalf("answer-level rejection must return to the answer agent: %+v", plan)
	}
}

func TestPlanResultRenderAndIngest(t *testing.T) {
	plan := PlanResult(TaskRender, "failed", "VIDEO_CHECK_FAILED", false, 0, 1, 1)
	if plan.Action != ActionRetry || plan.EventType != "task.retry" {
		t.Fatalf("expected one render retry: %+v", plan)
	}
	plan = PlanResult(TaskRender, "failed", "VIDEO_CHECK_FAILED", false, 0, 1, 2)
	if plan.Action != ActionFail {
		t.Fatalf("expected render failure after retry: %+v", plan)
	}
	plan = PlanResult(TaskRender, "completed", "", false, 0, 1, 1)
	if plan.Action != ActionComplete || plan.Status != StatusCompleted || plan.Phase != PhaseDone {
		t.Fatalf("unexpected render completion: %+v", plan)
	}
	plan = PlanResult(TaskIngest, "failed", "INVALID_AUDIO", false, 0, 1, 1)
	if plan.Action != ActionAwaitAudio || plan.EventType != "audio.rejected" {
		t.Fatalf("unexpected ingest failure: %+v", plan)
	}
	plan = PlanResult(TaskIngest, "cancelled", "", false, 0, 1, 1)
	if plan.Action != ActionCancelled {
		t.Fatalf("unexpected ingest cancellation: %+v", plan)
	}
}

func TestQueuedKindWaitsForAudioIngest(t *testing.T) {
	input, _ := json.Marshal(NormalizedInput{
		Audio: &AudioRef{AudioObjectKey: "audio", WordsObjectKey: "words", ScriptSHA256: "abc"},
	})
	if kind := QueuedKind(PhasePrepare, input, []byte(`{}`)); kind != TaskIngest {
		t.Fatalf("expected ingest, got %s", kind)
	}
	checkpoint, _ := json.Marshal(map[string]any{AudioIngestedMarker: true})
	if kind := QueuedKind(PhasePrepare, input, checkpoint); kind != TaskPrepare {
		t.Fatalf("expected prepare after ingest, got %s", kind)
	}
	if kind := QueuedKind(PhaseAuthor, nil, nil); kind != TaskAuthor {
		t.Fatalf("expected author, got %s", kind)
	}
	if kind := QueuedKind(PhaseDone, nil, nil); kind != "" {
		t.Fatalf("done phase must not queue work")
	}
}

func TestRecoveryPhase(t *testing.T) {
	cases := map[Phase]Phase{PhaseAuthor: PhaseAuthor, PhasePrepare: PhasePrepare, PhaseRender: PhaseRender, PhaseDone: PhaseAuthor}
	for input, want := range cases {
		if got := RecoveryPhase(input); got != want {
			t.Fatalf("RecoveryPhase(%s)=%s want %s", input, got, want)
		}
	}
}

func TestValidateArtifactName(t *testing.T) {
	for _, name := range []string{"video", "quality", "lesson.v1", "words.json", "a-b_c"} {
		if !ValidArtifactName(name) {
			t.Fatalf("%q should be valid", name)
		}
	}
	for _, name := range []string{"", "../x", ".hidden", "a/b", "a b", "-bad"} {
		if ValidArtifactName(name) {
			t.Fatalf("%q should be invalid", name)
		}
	}
}

func TestRetryablePlanKeepsPhase(t *testing.T) {
	cases := []struct {
		kind  TaskKind
		phase Phase
	}{
		{TaskPrepare, PhasePrepare},
		{TaskRender, PhaseRender},
		{TaskIngest, PhasePrepare},
	}
	for _, test := range cases {
		plan := PlanResult(test.kind, "retryable", "STORAGE_ERROR", false, 0, 1, 1)
		if plan.Action != ActionRetry || plan.Status != StatusQueued || plan.Phase != test.phase || plan.NextTask != test.kind {
			t.Fatalf("unexpected retry plan for %s: %+v", test.kind, plan)
		}
	}
	plan := PlanResult(TaskAuthor, "retryable", "MODEL_UNAVAILABLE", false, 0, 1, 1)
	if plan.Action != ActionRetry || plan.Phase != PhaseAuthor || plan.NextTask != TaskAuthor {
		t.Fatalf("author model failure should retry once with the next model: %+v", plan)
	}
	if plan := PlanResult(TaskAuthor, "retryable", "MODEL_UNAVAILABLE", false, 0, 1, 3); plan.Action != ActionFail {
		t.Fatalf("author model fallback must stop after the retry budget: %+v", plan)
	}
	if plan := PlanResult(TaskPrepare, "retryable", "MODEL_UNAVAILABLE", false, 0, 1, 3); plan.Action != ActionFail {
		t.Fatalf("prepare model fallback must stop after the retry budget: %+v", plan)
	}
}
