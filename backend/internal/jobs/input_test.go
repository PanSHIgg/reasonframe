package jobs

import (
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
)

func validInput() JobInput {
	return JobInput{
		Problem: "Prove that n a_n is arithmetic.",
		Images:  []ImageInput{},
		Scope: Scope{
			Subject: "math", Grade: "Grade 12",
			Topics: []string{"sequences"},
		},
		Options: Options{Template: "auto", FPS: 24, Quality: "looks", Audio: "auto"},
	}
}

func TestValidateJobInput(t *testing.T) {
	input := validInput()
	if err := ValidateJobInput(&input, 8<<20); err != nil {
		t.Fatal(err)
	}
	input.Problem = " a "
	if err := ValidateJobInput(&input, 8<<20); err == nil {
		t.Fatal("short problem should be rejected")
	}
	input = validInput()
	input.Scope.Subject = "history"
	if err := ValidateJobInput(&input, 8<<20); err == nil {
		t.Fatal("invalid subject should be rejected")
	}
	input = validInput()
	input.Options.FPS = 60
	if err := ValidateJobInput(&input, 8<<20); err == nil {
		t.Fatal("invalid fps should be rejected")
	}
	input = validInput()
	input.Images = []ImageInput{{MimeType: "image/png", Base64: base64.StdEncoding.EncodeToString([]byte("<not a real png>"))}}
	if err := ValidateJobInput(&input, 8<<20); err != nil {
		t.Fatalf("input validation should not inspect image magic: %v", err)
	}
}

func TestParseWordTable(t *testing.T) {
	table := map[string]any{
		"schemaVersion": 1, "timeUnit": "seconds",
		"scriptSha256": strings.Repeat("a", 64),
		"words": []map[string]any{
			{"text": "证明", "start": 0.0, "end": 0.5},
			{"text": "数列", "start": 0.5, "duration": 0.4},
		},
	}
	encoded, _ := json.Marshal(table)
	if _, err := ParseWordTable(encoded, strings.Repeat("a", 64)); err != nil {
		t.Fatal(err)
	}
	table["scriptSha256"] = strings.Repeat("b", 64)
	encoded, _ = json.Marshal(table)
	if _, err := ParseWordTable(encoded, strings.Repeat("a", 64)); err == nil {
		t.Fatal("stale word table should be rejected")
	} else if err.(*CodedError).Code != "STALE_AUDIO" {
		t.Fatalf("unexpected error: %v", err)
	}
	if _, err := ParseWordTable([]byte(`{"schemaVersion":1,"timeUnit":"seconds","words":[]}`), ""); err == nil {
		t.Fatal("empty word table should be rejected")
	}
}

func TestValidateUploadMagic(t *testing.T) {
	png := []byte{0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0}
	if mime, err := ValidateUpload(UploadImage, "image/png", png, 8<<20, 44_000_000); err != nil || mime != "image/png" {
		t.Fatalf("valid png rejected: %s %v", mime, err)
	}
	if _, err := ValidateUpload(UploadImage, "image/jpeg", png, 8<<20, 44_000_000); err == nil {
		t.Fatal("mismatched image magic accepted")
	}
	mp3 := append([]byte("ID3"), make([]byte, 32)...)
	if mime, err := ValidateUpload(UploadAudio, "audio/mpeg", mp3, 8<<20, 44_000_000); err != nil || mime != "audio/mpeg" {
		t.Fatalf("valid mp3 rejected: %s %v", mime, err)
	}
	if _, err := ValidateUpload(UploadAudio, "audio/wav", mp3, 8<<20, 44_000_000); err == nil {
		t.Fatal("invalid audio content type accepted")
	}
	words := []byte(`{"schemaVersion":1,"timeUnit":"seconds","words":[{"text":"a","start":0,"end":1}]}`)
	if mime, err := ValidateUpload(UploadWords, "application/json", words, 8<<20, 44_000_000); err != nil || mime != "application/json" {
		t.Fatalf("valid words rejected: %s %v", mime, err)
	}
}

func TestPublicInputDropsObjectKeys(t *testing.T) {
	public := PublicInputFrom(NormalizedInput{
		Problem: "x", Images: []NormalizedImage{{MimeType: "image/png", ObjectKey: "secret/key", File: "inputs/a.png"}},
		Scope: Scope{Subject: "math", Grade: "g"}, Options: Options{Template: "auto", FPS: 24, Quality: "looks", Audio: "auto"},
	})
	encoded, _ := json.Marshal(public)
	if strings.Contains(string(encoded), "secret/key") || strings.Contains(string(encoded), "inputs/a.png") {
		t.Fatalf("public input leaked object key: %s", encoded)
	}
	if !strings.Contains(string(encoded), `"images":[{"mimeType":"image/png"}]`) {
		t.Fatalf("unexpected public images: %s", encoded)
	}
}
