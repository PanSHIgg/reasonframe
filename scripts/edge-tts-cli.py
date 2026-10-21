"""One-shot Edge TTS worker used by the ReasonFrame agent tool.

Reads a JSON request, synthesizes the complete narration in one SSML message,
writes the MP3 and word table to disk, and prints a small metadata line.
No HTTP server is started.
"""
from __future__ import annotations

import argparse
import asyncio
import importlib.util
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]


def load_adapter():
    path = pathlib.Path(__file__).with_name("edge-tts-server.py")
    spec = importlib.util.spec_from_file_location("reasonframe_edge_adapter", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True)
    parser.add_argument("--audio", required=True)
    parser.add_argument("--words", required=True)
    args = parser.parse_args()
    try:
        payload = json.loads(pathlib.Path(args.input).read_text(encoding="utf-8"))
        text = payload["text"]
        if not isinstance(text, str) or not text.strip():
            raise ValueError("text must be the complete, nonempty narration")
        adapter = load_adapter()
        script_hash = adapter.digest(text.encode("utf-8"))
        if payload.get("scriptSha256") != script_hash:
            raise ValueError("scriptSha256 does not match the complete text")
        if payload.get("wordTimestamps") is not True:
            raise ValueError("wordTimestamps must be true")
        voice = payload.get("voice") or adapter.DEFAULT_VOICE
        if not isinstance(voice, str) or len(voice) > 120:
            raise ValueError("voice must be a valid voice name")
        rate = payload.get("rate") or "+0%"
        if not isinstance(rate, str) or len(rate) > 20:
            raise ValueError("rate is invalid")
        audio, table, cached = asyncio.run(adapter.synthesize(text, voice, rate, script_hash))
        audio_path, words_path = pathlib.Path(args.audio), pathlib.Path(args.words)
        audio_path.parent.mkdir(parents=True, exist_ok=True)
        words_path.parent.mkdir(parents=True, exist_ok=True)
        audio_path.write_bytes(audio)
        words_path.write_text(json.dumps(table, ensure_ascii=False), encoding="utf-8")
        print(json.dumps({
            "scriptSha256": script_hash,
            "voice": voice,
            "rate": rate,
            "cached": cached,
            "synthesisRequests": 0 if cached else 1,
            "audioBytes": len(audio),
            "words": len(table.get("words", [])),
        }, ensure_ascii=False), flush=True)
        return 0
    except Exception as error:
        print(json.dumps({"error": type(error).__name__, "message": str(error)}, ensure_ascii=False), file=sys.stderr, flush=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
