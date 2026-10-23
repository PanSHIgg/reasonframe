package storage

import "testing"

func TestNormalizeEndpointKeepsHostPort(t *testing.T) {
	endpoint, secure := normalizeEndpoint("minio:9000", false)
	if endpoint != "minio:9000" || secure {
		t.Fatalf("bare host:port was mangled: %q %v", endpoint, secure)
	}
	endpoint, secure = normalizeEndpoint("https://s3.example.test/", false)
	if endpoint != "s3.example.test" || !secure {
		t.Fatalf("https endpoint not normalized: %q %v", endpoint, secure)
	}
	endpoint, secure = normalizeEndpoint("http://127.0.0.1:9000", true)
	if endpoint != "127.0.0.1:9000" || secure {
		t.Fatalf("http endpoint should force insecure: %q %v", endpoint, secure)
	}
}
