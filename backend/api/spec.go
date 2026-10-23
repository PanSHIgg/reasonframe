package openapi

import (
	_ "embed"
	"encoding/json"
	"sync"

	"gopkg.in/yaml.v3"
)

//go:embed openapi.yaml
var yamlSpec []byte

var (
	once     sync.Once
	jsonSpec []byte
	jsonErr  error
)

// JSON converts the embedded OpenAPI YAML into the JSON document served at
// /openapi.json.
func JSON() ([]byte, error) {
	once.Do(func() {
		var document any
		if err := yaml.Unmarshal(yamlSpec, &document); err != nil {
			jsonErr = err
			return
		}
		jsonSpec, jsonErr = json.Marshal(document)
	})
	return jsonSpec, jsonErr
}
