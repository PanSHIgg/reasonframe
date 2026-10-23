package main

import "testing"

func TestParseQueues(t *testing.T) {
	queues, err := parseQueues("render, author,render")
	if err != nil {
		t.Fatal(err)
	}
	if len(queues) != 2 || queues[0] != "render" || queues[1] != "author" {
		t.Fatalf("unexpected queues: %v", queues)
	}
	for _, value := range []string{"", "render,audio", "ingest_audio"} {
		if _, err := parseQueues(value); err == nil {
			t.Fatalf("parseQueues(%q) should fail", value)
		}
	}
}
