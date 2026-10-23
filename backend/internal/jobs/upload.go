package jobs

import (
	"encoding/json"
	"strings"
)

type UploadKind string

const (
	UploadImage UploadKind = "image"
	UploadAudio UploadKind = "audio"
	UploadWords UploadKind = "words"
)

func ParseUploadKind(value string) (UploadKind, error) {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "image":
		return UploadImage, nil
	case "audio":
		return UploadAudio, nil
	case "words":
		return UploadWords, nil
	default:
		return "", Errorf("UPLOAD_INVALID", "kind must be image, audio, or words")
	}
}

func UploadMaxBytes(kind UploadKind, maxImage, maxAudio int64) int64 {
	switch kind {
	case UploadImage:
		return maxImage
	case UploadAudio:
		return maxAudio
	case UploadWords:
		return MaxWordsBytes
	default:
		return 0
	}
}

// ValidateUpload validates a complete upload body before it is written to
// object storage. It returns the normalized MIME type.
func ValidateUpload(kind UploadKind, mime string, data []byte, maxImage, maxAudio int64) (string, error) {
	limit := UploadMaxBytes(kind, maxImage, maxAudio)
	if limit <= 0 {
		return "", Errorf("UPLOAD_INVALID", "unknown upload kind")
	}
	if int64(len(data)) > limit {
		return "", Errorf("PAYLOAD_TOO_LARGE", "upload exceeds the configured limit")
	}
	normalized := strings.ToLower(strings.TrimSpace(strings.Split(mime, ";")[0]))
	switch kind {
	case UploadImage:
		if normalized == "" || normalized == "application/octet-stream" {
			normalized = sniffImageMime(data)
		}
		if _, ok := allowedImageMimes[normalized]; !ok {
			return "", Errorf("UPLOAD_INVALID", "image must be PNG, JPEG, or WebP")
		}
		if !matchesImageMagic(normalized, data) {
			return "", Errorf("UPLOAD_INVALID", "image bytes do not match the declared content type")
		}
	case UploadAudio:
		if len(data) == 0 || !isMP3(data) {
			return "", Errorf("UPLOAD_INVALID", "audio must be a valid MP3 stream")
		}
		if normalized != "audio/mpeg" && normalized != "audio/mp3" && normalized != "application/octet-stream" {
			return "", Errorf("UPLOAD_INVALID", "audio must be audio/mpeg")
		}
		normalized = "audio/mpeg"
	case UploadWords:
		if normalized != "" && normalized != "application/json" && normalized != "text/json" && normalized != "application/octet-stream" {
			return "", Errorf("UPLOAD_INVALID", "words must be application/json")
		}
		var probe map[string]json.RawMessage
		if err := json.Unmarshal(data, &probe); err != nil {
			return "", Errorf("UPLOAD_INVALID", "words must be a JSON object")
		}
		if _, err := ParseWordTable(data, ""); err != nil {
			return "", Errorf("UPLOAD_INVALID", err.Error())
		}
		normalized = "application/json"
	default:
		return "", Errorf("UPLOAD_INVALID", "unknown upload kind")
	}
	return normalized, nil
}

func sniffImageMime(data []byte) string {
	switch {
	case len(data) >= 8 && data[0] == 0x89 && data[1] == 'P' && data[2] == 'N' && data[3] == 'G':
		return "image/png"
	case len(data) >= 3 && data[0] == 0xFF && data[1] == 0xD8 && data[2] == 0xFF:
		return "image/jpeg"
	case len(data) >= 12 && string(data[0:4]) == "RIFF" && string(data[8:12]) == "WEBP":
		return "image/webp"
	default:
		return ""
	}
}

func matchesImageMagic(mime string, data []byte) bool {
	switch mime {
	case "image/png":
		return len(data) >= 8 && data[0] == 0x89 && data[1] == 'P' && data[2] == 'N' && data[3] == 'G' && data[4] == 0x0D && data[5] == 0x0A && data[6] == 0x1A && data[7] == 0x0A
	case "image/jpeg":
		return len(data) >= 3 && data[0] == 0xFF && data[1] == 0xD8 && data[2] == 0xFF
	case "image/webp":
		return len(data) >= 12 && string(data[0:4]) == "RIFF" && string(data[8:12]) == "WEBP"
	default:
		return false
	}
}

func UploadExtension(kind UploadKind, mime string) string {
	switch kind {
	case UploadImage:
		return ImageExtension(mime)
	case UploadAudio:
		return "mp3"
	case UploadWords:
		return "json"
	default:
		return "bin"
	}
}
