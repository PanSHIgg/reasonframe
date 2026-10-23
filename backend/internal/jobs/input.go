package jobs

import (
	"encoding/base64"
	"fmt"
	"strings"
	"unicode/utf8"
)

var allowedImageMimes = map[string]string{
	"image/png":  "png",
	"image/jpeg": "jpg",
	"image/webp": "webp",
}

func ApplyInputDefaults(in *JobInput) {
	if in.Images == nil {
		in.Images = []ImageInput{}
	}
	if in.Scope.Topics == nil {
		in.Scope.Topics = []string{}
	}
	if in.Scope.AllowedMethods == nil {
		in.Scope.AllowedMethods = []string{}
	}
	if in.Scope.ForbiddenMethods == nil {
		in.Scope.ForbiddenMethods = []string{}
	}
	if in.Options.Template == "" {
		in.Options.Template = "auto"
	}
	if in.Options.FPS == 0 {
		in.Options.FPS = 24
	}
	if in.Options.Quality == "" {
		in.Options.Quality = "looks"
	}
	if in.Options.Audio == "" {
		in.Options.Audio = "auto"
	}
}

func runeLen(s string) int { return utf8.RuneCountInString(s) }

func ValidateJobInput(in *JobInput, maxImageBytes int64) error {
	in.Problem = strings.TrimSpace(in.Problem)
	if n := runeLen(in.Problem); n < 3 || n > 24000 {
		return bad("problem", "must contain 3..24000 characters")
	}
	if len(in.Images) > 4 {
		return bad("images", "at most 4 images are allowed")
	}
	for i, image := range in.Images {
		field := fmt.Sprintf("images.%d", i)
		if image.Base64 == "" && image.UploadID == "" {
			return bad(field, "one of base64 or uploadId is required")
		}
		if image.Base64 != "" && image.UploadID != "" {
			return bad(field, "base64 and uploadId are mutually exclusive")
		}
		if image.Base64 != "" {
			if len(image.Base64) < 16 || len(image.Base64) > 12_000_000 {
				return bad(field+".base64", "must contain 16..12000000 characters")
			}
			if !validImageMime(image.MimeType) {
				return bad(field+".mimeType", "must be image/png, image/jpeg, or image/webp")
			}
			decoded, err := base64.StdEncoding.DecodeString(image.Base64)
			if err != nil {
				return bad(field+".base64", "must be valid standard base64")
			}
			if int64(len(decoded)) > maxImageBytes {
				return &CodedError{Code: "PAYLOAD_TOO_LARGE", Message: field + ".base64 exceeds MAX_IMAGE_BYTES"}
			}
		} else if image.MimeType != "" && !validImageMime(image.MimeType) {
			return bad(field+".mimeType", "must be image/png, image/jpeg, or image/webp")
		}
	}
	switch in.Scope.Subject {
	case "math", "physics", "chemistry":
	default:
		return bad("scope.subject", "must be math, physics, or chemistry")
	}
	in.Scope.Grade = strings.TrimSpace(in.Scope.Grade)
	if n := runeLen(in.Scope.Grade); n < 1 || n > 80 {
		return bad("scope.grade", "must contain 1..80 characters")
	}
	if err := validateStringArray("scope.topics", in.Scope.Topics, 40, 120); err != nil {
		return err
	}
	if err := validateStringArray("scope.allowedMethods", in.Scope.AllowedMethods, 30, 160); err != nil {
		return err
	}
	if err := validateStringArray("scope.forbiddenMethods", in.Scope.ForbiddenMethods, 30, 160); err != nil {
		return err
	}
	if runeLen(in.Supplements) > 12000 {
		return bad("supplements", "must contain at most 12000 characters")
	}
	switch in.Options.Template {
	case "auto", "solid-geometry", "blank":
	default:
		return bad("options.template", "must be auto, solid-geometry, or blank")
	}
	if in.Options.FPS != 24 && in.Options.FPS != 30 {
		return bad("options.fps", "must be 24 or 30")
	}
	switch in.Options.Quality {
	case "draft", "looks", "delivery":
	default:
		return bad("options.quality", "must be draft, looks, or delivery")
	}
	switch in.Options.Audio {
	case "auto", "provided":
	default:
		return bad("options.audio", "must be auto or provided")
	}
	return nil
}

func validateStringArray(field string, values []string, maxItems, maxLen int) error {
	if len(values) > maxItems {
		return bad(field, fmt.Sprintf("must contain at most %d items", maxItems))
	}
	for i, v := range values {
		if runeLen(v) > maxLen {
			return bad(fmt.Sprintf("%s.%d", field, i), fmt.Sprintf("must contain at most %d characters", maxLen))
		}
	}
	return nil
}

func bad(field, message string) error {
	return &CodedError{Code: "BAD_INPUT", Message: field + ": " + message}
}

func validImageMime(mime string) bool {
	_, ok := allowedImageMimes[mime]
	return ok
}

func ImageExtension(mime string) string {
	if ext, ok := allowedImageMimes[mime]; ok {
		return ext
	}
	return "bin"
}

func PublicInputFrom(n NormalizedInput) PublicInput {
	images := make([]PublicImage, 0, len(n.Images))
	for _, image := range n.Images {
		images = append(images, PublicImage{MimeType: image.MimeType})
	}
	return PublicInput{
		Problem: n.Problem, Images: images, Scope: n.Scope,
		Supplements: n.Supplements, Options: n.Options,
	}
}
