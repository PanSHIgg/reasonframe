package api

import (
	"context"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/reasonframe/reasonframe/backend/internal/jobs"
	"github.com/reasonframe/reasonframe/backend/internal/store"
)

type uploadResponse struct {
	ID        string    `json:"id"`
	Kind      string    `json:"kind"`
	MimeType  string    `json:"mimeType"`
	SizeBytes int64     `json:"sizeBytes"`
	SHA256    string    `json:"sha256"`
	ExpiresAt time.Time `json:"expiresAt"`
}

func (s *Server) createUpload(w http.ResponseWriter, r *http.Request) {
	principal, ok := principalOf(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Valid service bearer token required")
		return
	}
	kindValue := strings.TrimSpace(r.URL.Query().Get("kind"))
	if kindValue == "" {
		kindValue = strings.TrimSpace(r.Header.Get("X-Upload-Kind"))
	}
	isMultipart := strings.HasPrefix(strings.ToLower(r.Header.Get("Content-Type")), "multipart/form-data")
	requestLimit := maxUploadLimit(s.Config.MaxImageBytes, s.Config.MaxAudioBytes)
	var (
		kind jobs.UploadKind
		mime string
		data []byte
		err  error
	)

	if isMultipart {
		r.Body = http.MaxBytesReader(w, r.Body, requestLimit+(2<<20))
		if err := r.ParseMultipartForm(16 << 20); err != nil {
			s.writeMappedError(w, r, err)
			return
		}
		defer r.MultipartForm.RemoveAll()
		if kindValue == "" {
			kindValue = r.FormValue("kind")
		}
		kind, err = jobs.ParseUploadKind(kindValue)
		if err != nil {
			s.writeMappedError(w, r, err)
			return
		}
		file, header, err := openMultipartFile(r)
		if err != nil {
			s.writeMappedError(w, r, jobs.Errorf("UPLOAD_INVALID", "multipart request must include a file"))
			return
		}
		defer file.Close()
		mime = header.Header.Get("Content-Type")
		if formMime := r.FormValue("mimeType"); formMime != "" {
			mime = formMime
		}
		limit := jobs.UploadMaxBytes(kind, s.Config.MaxImageBytes, s.Config.MaxAudioBytes)
		data, err = io.ReadAll(io.LimitReader(file, limit+1))
		if err != nil {
			s.writeMappedError(w, r, err)
			return
		}
		if int64(len(data)) > limit {
			s.writeMappedError(w, r, jobs.Errorf("PAYLOAD_TOO_LARGE", "upload exceeds the configured limit"))
			return
		}
	} else {
		kind, err = jobs.ParseUploadKind(kindValue)
		if err != nil {
			s.writeMappedError(w, r, err)
			return
		}
		limit := jobs.UploadMaxBytes(kind, s.Config.MaxImageBytes, s.Config.MaxAudioBytes)
		mime = r.Header.Get("Content-Type")
		data, err = io.ReadAll(io.LimitReader(http.MaxBytesReader(w, r.Body, limit+1), limit+1))
		if err != nil {
			s.writeMappedError(w, r, err)
			return
		}
		if int64(len(data)) > limit {
			s.writeMappedError(w, r, jobs.Errorf("PAYLOAD_TOO_LARGE", "upload exceeds the configured limit"))
			return
		}
	}

	normalizedMime, err := jobs.ValidateUpload(kind, mime, data, s.Config.MaxImageBytes, s.Config.MaxAudioBytes)
	if err != nil {
		s.writeMappedError(w, r, err)
		return
	}
	uploadID := uuid.New()
	objectKey := fmt.Sprintf("uploads/%s/%s", principal.AccountID, uploadID)
	if err := s.Storage.PutBytes(r.Context(), objectKey, data, normalizedMime); err != nil {
		s.writeMappedError(w, r, jobs.Errorf("SERVICE_UNAVAILABLE", "Object storage is unavailable"))
		return
	}
	upload, err := s.Store.CreateUpload(r.Context(), store.CreateUploadParams{
		ID: uploadID, AccountID: principal.AccountID, Kind: string(kind), ObjectKey: objectKey,
		MimeType: normalizedMime, SizeBytes: int64(len(data)), SHA256: sha256Hex(data),
		ExpiresAt: time.Now().UTC().Add(24 * time.Hour),
	})
	if err != nil {
		_ = s.Storage.Remove(context.Background(), objectKey)
		s.writeMappedError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, uploadResponse{
		ID: upload.ID.String(), Kind: upload.Kind, MimeType: normalizedMime,
		SizeBytes: int64(len(data)), SHA256: sha256Hex(data), ExpiresAt: upload.ExpiresAt,
	})
}

func openMultipartFile(r *http.Request) (multipart.File, *multipart.FileHeader, error) {
	if file, header, err := r.FormFile("file"); err == nil {
		return file, header, nil
	}
	for _, headers := range r.MultipartForm.File {
		if len(headers) > 0 {
			file, err := headers[0].Open()
			return file, headers[0], err
		}
	}
	return nil, nil, http.ErrMissingFile
}

func maxUploadLimit(maxImage, maxAudio int64) int64 {
	limit := maxImage
	if maxAudio > limit {
		limit = maxAudio
	}
	if jobs.MaxWordsBytes > limit {
		limit = jobs.MaxWordsBytes
	}
	return limit
}
