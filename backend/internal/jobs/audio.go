package jobs

import (
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"strings"
)

const MaxWordsBytes int64 = 20 << 20

type Word struct {
	Text     string   `json:"text"`
	Start    float64  `json:"start"`
	End      *float64 `json:"end"`
	Duration *float64 `json:"duration"`
}

type WordTable struct {
	SchemaVersion int    `json:"schemaVersion"`
	TimeUnit      string `json:"timeUnit"`
	ScriptSHA256  string `json:"scriptSha256,omitempty"`
	Words         []Word `json:"words"`
}

var sha256Pattern = regexp.MustCompile(`^[a-f0-9]{64}$`)

func ValidSHA256(value string) bool { return sha256Pattern.MatchString(value) }

func ParseWordTable(data []byte, expectedScript string) (*WordTable, error) {
	if len(data) == 0 {
		return nil, Errorf("AUDIO_REJECTED", "word table is required")
	}
	var table WordTable
	if err := json.Unmarshal(data, &table); err != nil {
		return nil, Errorf("AUDIO_REJECTED", "word table must be a JSON object")
	}
	if table.SchemaVersion != 1 {
		return nil, Errorf("AUDIO_REJECTED", "word table schemaVersion must be 1")
	}
	switch table.TimeUnit {
	case "seconds", "milliseconds", "100ns":
	default:
		return nil, Errorf("AUDIO_REJECTED", "word table timeUnit must be seconds, milliseconds, or 100ns")
	}
	if table.ScriptSHA256 != "" {
		if !ValidSHA256(table.ScriptSHA256) {
			return nil, Errorf("AUDIO_REJECTED", "word table scriptSha256 must be 64 lowercase hex characters")
		}
		if expectedScript != "" && table.ScriptSHA256 != expectedScript {
			return nil, Errorf("STALE_AUDIO", "MP3/word table belong to a different narration; fetch the current narration and regenerate the whole audio")
		}
	}
	if len(table.Words) < 1 || len(table.Words) > 50000 {
		return nil, Errorf("AUDIO_REJECTED", "word table must contain 1..50000 words")
	}
	for i := range table.Words {
		word := &table.Words[i]
		if runeLen(word.Text) > 300 {
			return nil, Errorf("AUDIO_REJECTED", fmt.Sprintf("words.%d.text must contain at most 300 characters", i))
		}
		if !finite(word.Start) || word.Start < 0 {
			return nil, Errorf("AUDIO_REJECTED", fmt.Sprintf("words.%d.start must be a nonnegative finite number", i))
		}
		if word.End == nil && word.Duration == nil {
			return nil, Errorf("AUDIO_REJECTED", fmt.Sprintf("words.%d must have end or duration", i))
		}
		if word.End != nil && (!finite(*word.End) || *word.End <= 0) {
			return nil, Errorf("AUDIO_REJECTED", fmt.Sprintf("words.%d.end must be a positive finite number", i))
		}
		if word.Duration != nil && (!finite(*word.Duration) || *word.Duration <= 0) {
			return nil, Errorf("AUDIO_REJECTED", fmt.Sprintf("words.%d.duration must be a positive finite number", i))
		}
	}
	return &table, nil
}

func finite(v float64) bool { return !math.IsNaN(v) && !math.IsInf(v, 0) }

func ValidateAudioBytes(mime string, data []byte, maxBytes int64) (string, error) {
	if len(data) == 0 {
		return "", Errorf("AUDIO_REJECTED", "audio must not be empty")
	}
	if int64(len(data)) > maxBytes {
		return "", Errorf("PAYLOAD_TOO_LARGE", "audio exceeds MAX_AUDIO_BYTES")
	}
	normalized := strings.ToLower(strings.TrimSpace(strings.Split(mime, ";")[0]))
	if normalized == "audio/mp3" {
		normalized = "audio/mpeg"
	}
	if normalized != "audio/mpeg" && normalized != "application/octet-stream" {
		return "", Errorf("AUDIO_REJECTED", "audio must be MP3 (audio/mpeg)")
	}
	if !isMP3(data) {
		return "", Errorf("AUDIO_REJECTED", "audio is not a valid MP3 stream")
	}
	return "audio/mpeg", nil
}

func isMP3(data []byte) bool {
	if len(data) >= 3 && data[0] == 'I' && data[1] == 'D' && data[2] == '3' {
		return true
	}
	if len(data) >= 2 && data[0] == 0xFF && (data[1]&0xE0) == 0xE0 {
		return true
	}
	return false
}

func SHA256HexUpperOrLower(value string) bool { return ValidSHA256(strings.ToLower(value)) }

func DecodeHex(value string) ([]byte, bool) {
	b, err := hex.DecodeString(value)
	return b, err == nil
}
