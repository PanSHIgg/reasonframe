package jobs

type Action string

const (
	ActionAdvance    Action = "advance"
	ActionComplete   Action = "complete"
	ActionAwaitAudio Action = "await_audio"
	ActionFail       Action = "fail"
	ActionRepair     Action = "repair"
	ActionRetry      Action = "retry"
	ActionCancelled  Action = "cancelled"
)

type ResultPlan struct {
	Action    Action
	Status    Status
	Phase     Phase
	NextTask  TaskKind
	EventType string
}

// PlanResult maps an AI TaskResult onto the externally visible job state.
// phaseRuns is the number of runs already recorded for the current task type,
// including the currently running attempt. It caps model fallback attempts and
// the render video-check retry.
func PlanResult(kind TaskKind, resultStatus, errorCode string, repairable bool, autoRepairs, maxRepairs, phaseRuns int) ResultPlan {
	status := normalizeStatus(resultStatus)
	switch status {
	case "cancelled":
		return ResultPlan{Action: ActionCancelled, Status: StatusCancelled, Phase: kind.DBPhase(), EventType: "cancelled"}
	case "retryable":
		switch kind {
		case TaskAuthor:
			// A retryable author failure is normally a provider/model outage.
			// Retry so the AI service can select the next configured model.
			if phaseRuns < 3 {
				return ResultPlan{Action: ActionRetry, Status: StatusQueued, Phase: kind.DBPhase(), NextTask: kind, EventType: "task.retry"}
			}
			return failed(kind)
		case TaskPrepare:
			// Allow one run per configured model, then stop instead of
			// cycling through unavailable models forever.
			if phaseRuns < 3 {
				return ResultPlan{Action: ActionRetry, Status: StatusQueued, Phase: kind.DBPhase(), NextTask: kind, EventType: "task.retry"}
			}
			return failed(kind)
		case TaskRender, TaskIngest:
			return ResultPlan{Action: ActionRetry, Status: StatusQueued, Phase: kind.DBPhase(), NextTask: kind, EventType: "task.retry"}
		default:
			return failed(kind)
		}
	}
	switch kind {
	case TaskAuthor:
		switch status {
		case "completed":
			return ResultPlan{Action: ActionAdvance, Status: StatusQueued, Phase: PhasePrepare, NextTask: TaskPrepare, EventType: "source.approved"}
		default:
			return failed(kind)
		}
	case TaskPrepare:
		switch status {
		case "completed":
			return ResultPlan{Action: ActionAdvance, Status: StatusQueued, Phase: PhaseRender, NextTask: TaskRender, EventType: "stage"}
		case "awaiting_audio":
			return ResultPlan{Action: ActionAwaitAudio, Status: StatusAwaitingAudio, Phase: PhasePrepare, EventType: "awaiting_audio"}
		default:
			if repairable && autoRepairs < maxRepairs {
				// Answer-level problems must return to the answer agent. Visual-only
				// problems stay in the video loop and keep the approved answer.
				if errorCode == "ANSWER_REVISION_REQUIRED" {
					return ResultPlan{Action: ActionRepair, Status: StatusQueued, Phase: PhaseAuthor, NextTask: TaskAuthor, EventType: "repair.queued"}
				}
				return ResultPlan{Action: ActionRepair, Status: StatusQueued, Phase: PhasePrepare, NextTask: TaskPrepare, EventType: "repair.queued"}
			}
			return failed(kind)
		}
	case TaskRender:
		switch status {
		case "completed":
			return ResultPlan{Action: ActionComplete, Status: StatusCompleted, Phase: PhaseDone, EventType: "completed"}
		default:
			if errorCode == "VIDEO_CHECK_FAILED" && phaseRuns < 2 {
				return ResultPlan{Action: ActionRetry, Status: StatusQueued, Phase: PhaseRender, NextTask: TaskRender, EventType: "task.retry"}
			}
			return failed(kind)
		}
	case TaskIngest:
		switch status {
		case "completed":
			return ResultPlan{Action: ActionAdvance, Status: StatusQueued, Phase: PhasePrepare, NextTask: TaskPrepare, EventType: "stage"}
		default:
			return ResultPlan{Action: ActionAwaitAudio, Status: StatusAwaitingAudio, Phase: PhasePrepare, EventType: "audio.rejected"}
		}
	default:
		return failed(kind)
	}
}

func failed(kind TaskKind) ResultPlan {
	return ResultPlan{Action: ActionFail, Status: StatusFailed, Phase: kind.DBPhase(), EventType: "failed"}
}

func normalizeStatus(value string) string {
	switch value {
	case "completed", "succeeded", "success", "ok":
		return "completed"
	case "awaiting_audio", "await_audio":
		return "awaiting_audio"
	case "failed", "failure", "error":
		return "failed"
	case "retryable", "retry":
		return "retryable"
	case "cancelled", "canceled":
		return "cancelled"
	default:
		return "failed"
	}
}

func ValidArtifactName(name string) bool {
	if name == "" || len(name) > 128 {
		return false
	}
	for i, r := range name {
		if r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '_' || r == '-' || r == '.' {
			if i == 0 && (r == '.' || r == '-' || r == '_') {
				return false
			}
			continue
		}
		return false
	}
	return true
}
