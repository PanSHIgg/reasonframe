package api

import (
	"net/http"
)

func (s *Server) getNarration(w http.ResponseWriter, r *http.Request) {
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
	job, err := s.Store.GetJobForAccount(r.Context(), principal.AccountID, jobID)
	if err != nil {
		s.writeMappedError(w, r, err)
		return
	}
	if job.ScriptSHA256 == nil || *job.ScriptSHA256 == "" {
		writeError(w, http.StatusConflict, "INVALID_STATE", "Narration is available after authoring and independent review")
		return
	}
	artifact, err := s.Store.GetArtifact(r.Context(), principal.AccountID, job.ID, "narration")
	if err != nil {
		s.writeMappedError(w, r, notFound("Narration artifact is not available"))
		return
	}
	data, err := s.Storage.ReadAll(r.Context(), artifact.ObjectKey, 16<<20)
	if err != nil {
		s.writeMappedError(w, r, notFound("Narration artifact is not available"))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"scriptSha256": *job.ScriptSHA256, "text": string(data)})
}
