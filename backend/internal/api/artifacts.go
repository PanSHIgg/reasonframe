package api

import (
	"net/http"
	"path"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/reasonframe/reasonframe/backend/internal/jobs"
)

func (s *Server) downloadArtifact(w http.ResponseWriter, r *http.Request) {
	principal, ok := principalOf(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Valid service bearer token required")
		return
	}
	jobID, err := parseJobID(r)
	if err != nil {
		s.writeMappedError(w, r, err)
		return
	}
	name := chi.URLParam(r, "name")
	if !jobs.ValidArtifactName(name) || strings.Contains(name, "/") {
		s.writeMappedError(w, r, notFound("Artifact not found"))
		return
	}
	job, err := s.Store.GetJobForAccount(r.Context(), principal.AccountID, jobID)
	if err != nil {
		s.writeMappedError(w, r, err)
		return
	}
	artifact, err := s.Store.GetArtifact(r.Context(), principal.AccountID, jobID, name)
	if err != nil {
		s.writeMappedError(w, r, notFound("Artifact not found"))
		return
	}
	if artifact.Name == "video" && job.Status != jobs.StatusCompleted {
		s.writeMappedError(w, r, notFound("Artifact not found"))
		return
	}
	object, err := s.Storage.Get(r.Context(), artifact.ObjectKey)
	if err != nil {
		s.writeMappedError(w, r, notFound("Artifact not found"))
		return
	}
	defer object.Close()
	info, err := object.Stat()
	if err != nil {
		s.writeMappedError(w, r, notFound("Artifact not found"))
		return
	}
	filename := downloadFilename(artifact.Name, artifact.MimeType)
	w.Header().Set("Content-Type", artifact.MimeType)
	w.Header().Set("Content-Disposition", `attachment; filename="`+filename+`"`)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "private, max-age=0")
	http.ServeContent(w, r, filename, info.LastModified, object)
}

func downloadFilename(name, mimeType string) string {
	if strings.Contains(name, ".") {
		return path.Base(name)
	}
	extension := map[string]string{
		"video/mp4":                 ".mp4",
		"audio/mpeg":                ".mp3",
		"application/json":          ".json",
		"text/plain":                ".txt",
		"text/plain; charset=utf-8": ".txt",
		"application/x-subrip":      ".srt",
		"text/vtt":                  ".vtt",
		"text/javascript":           ".js",
		"text/css":                  ".css",
	}[strings.ToLower(mimeType)]
	return name + extension
}
