package openapi

import (
	"encoding/json"
	"testing"
)

func TestJSONContainsPublicContract(t *testing.T) {
	raw, err := JSON()
	if err != nil {
		t.Fatal(err)
	}
	var spec struct {
		OpenAPI    string                     `json:"openapi"`
		Paths      map[string]json.RawMessage `json:"paths"`
		Components struct {
			Schemas map[string]json.RawMessage `json:"schemas"`
		} `json:"components"`
	}
	if err := json.Unmarshal(raw, &spec); err != nil {
		t.Fatal(err)
	}
	if spec.OpenAPI != "3.1.0" {
		t.Fatalf("unexpected OpenAPI version %q", spec.OpenAPI)
	}
	for _, path := range []string{
		"/health", "/health/ready", "/openapi.json", "/v1/config", "/v1/jobs",
		"/v1/jobs/{id}", "/v1/jobs/{id}/events", "/v1/jobs/{id}/narration",
		"/v1/jobs/{id}/audio", "/v1/jobs/{id}/cancel", "/v1/jobs/{id}/retry",
		"/v1/jobs/{id}/artifacts/{name}", "/v1/uploads",
	} {
		if _, ok := spec.Paths[path]; !ok {
			t.Fatalf("OpenAPI document is missing %s", path)
		}
	}
	for _, schema := range []string{"JobInput", "AudioInput", "Upload", "Job"} {
		if _, ok := spec.Components.Schemas[schema]; !ok {
			t.Fatalf("OpenAPI document is missing schema %s", schema)
		}
	}
}
