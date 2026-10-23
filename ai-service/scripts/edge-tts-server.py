"""Local whole-script Edge TTS adapter with exact word timestamps and caching."""
import argparse
import asyncio
import base64
import hashlib
import json
import pathlib
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import edge_tts
from edge_tts.communicate import escape, mkssml, remove_incompatible_characters, ssml_headers_plus_data

ROOT = pathlib.Path(__file__).resolve().parents[1]
CACHE = ROOT / '.reasonframe' / 'tts-cache'
LOCK = threading.Lock()
DEFAULT_VOICE = 'zh-CN-XiaoxiaoNeural'
MAX_REQUEST_BYTES = 60_000


def digest(data):
    return hashlib.sha256(data).hexdigest()


def whole_script_communicator(text, voice, rate):
    communicator = edge_tts.Communicate(
        text, voice, rate=rate, boundary='WordBoundary',
        connect_timeout=20, receive_timeout=120,
    )
    # The pinned SDK splits at 4096 bytes. Supply one escaped SSML body instead,
    # bounding the complete message (including headers) below the protocol frame limit.
    escaped_text = escape(remove_incompatible_characters(text)).encode('utf-8')
    request = ssml_headers_plus_data('0' * 32, 'Wed, 01 Jan 2025 00:00:00 GMT',
                                     mkssml(communicator.tts_config, escaped_text))
    request_bytes = len(request.encode('utf-8'))
    if request_bytes > MAX_REQUEST_BYTES:
        raise ValueError('The complete narration exceeds the 60000-byte single-message limit; '
                         'use a long-form TTS provider instead of splitting the script')
    communicator.texts = iter([escaped_text])
    return communicator, request_bytes


async def synthesize(text, voice, rate, script_hash):
    cache_key = digest(json.dumps({
        'text': text, 'voice': voice, 'rate': rate,
        'boundary': 'WordBoundary', 'edgeTtsVersion': edge_tts.__version__,
        'requestMode': 'one-ssml-v1',
    }, ensure_ascii=False, sort_keys=True).encode())
    audio_path = CACHE / (cache_key + '.mp3')
    words_path = CACHE / (cache_key + '.json')
    if audio_path.is_file() and words_path.is_file():
        audio = audio_path.read_bytes()
        table = json.loads(words_path.read_text())
        if table['scriptSha256'] == script_hash and table['audioSha256'] == digest(audio):
            return audio, table, True

    communicator, request_bytes = whole_script_communicator(text, voice, rate)
    audio_chunks, words = [], []
    async for event in communicator.stream():
        if event['type'] == 'audio':
            audio_chunks.append(event['data'])
        elif event['type'] == 'WordBoundary':
            words.append({
                'text': event['text'],
                'start': event['offset'] / 10_000_000,
                'end': (event['offset'] + event['duration']) / 10_000_000,
            })
    audio = b''.join(audio_chunks)
    if len(audio) < 1500 or not words:
        raise RuntimeError('Edge returned no complete MP3 or word timestamps')
    table = {
        'schemaVersion': 1, 'timeUnit': 'seconds', 'provider': 'edge-tts',
        'scriptSha256': script_hash, 'audioSha256': digest(audio),
        'synthesisRequests': 1, 'voice': voice, 'rate': rate, 'words': words,
        'requestMode': 'one-ssml-v1', 'requestBytes': request_bytes,
    }
    CACHE.mkdir(parents=True, exist_ok=True)
    pending_audio = audio_path.with_suffix('.partial.mp3')
    pending_words = words_path.with_suffix('.partial.json')
    pending_audio.write_bytes(audio)
    pending_words.write_text(json.dumps(table, ensure_ascii=False), encoding='utf-8')
    pending_audio.replace(audio_path)
    pending_words.replace(words_path)
    return audio, table, False


class Handler(BaseHTTPRequestHandler):
    def send_json(self, status, value):
        data = json.dumps(value, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path != '/health':
            return self.send_json(404, {'error': 'Not found'})
        self.send_json(200, {'ok': True, 'provider': 'edge-tts',
                             'voice': DEFAULT_VOICE, 'mode': 'whole-script'})

    def do_POST(self):
        if self.path != '/synthesize':
            return self.send_json(404, {'error': 'Not found'})
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= 1_000_000:
                raise ValueError('A JSON request body of at most 1 MB is required')
            payload = json.loads(self.rfile.read(length))
            text = payload['text']
            if not isinstance(text, str) or not text.strip():
                raise ValueError('text must be the complete, nonempty narration')
            script_hash = digest(text.encode('utf-8'))
            if payload.get('scriptSha256') != script_hash:
                raise ValueError('scriptSha256 does not match the complete text')
            voice = payload.get('voice') or DEFAULT_VOICE
            if not isinstance(voice, str) or len(voice) > 120:
                raise ValueError('voice must be a valid voice name')
            if payload.get('wordTimestamps') is not True:
                raise ValueError('wordTimestamps must be true')
        except (KeyError, ValueError, TypeError) as error:
            return self.send_json(422, {'error': str(error)})
        try:
            with LOCK:
                audio, words, cached = asyncio.run(synthesize(text, voice, '+0%', script_hash))
            print(json.dumps({'event': 'tts.complete', 'scriptSha256': script_hash,
                              'characters': len(text), 'words': len(words['words']),
                              'cached': cached, 'synthesisRequests': 0 if cached else 1}), flush=True)
            self.send_json(200, {'scriptSha256': script_hash,
                                  'audioBase64': base64.b64encode(audio).decode('ascii'),
                                  'words': words})
        except ValueError as error:
            self.send_json(422, {'error': str(error)})
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as error:
            print(json.dumps({'event': 'tts.error', 'type': type(error).__name__,
                              'message': str(error)}), flush=True)
            self.send_json(502, {'error': 'Whole-script Edge TTS failed; inspect the adapter log'})


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--host', default='127.0.0.1')
    parser.add_argument('--port', type=int, default=4311)
    args = parser.parse_args()
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    server.daemon_threads = True
    print(json.dumps({'service': 'reasonframe-edge-tts',
                      'url': f'http://{args.host}:{args.port}',
                      'voice': DEFAULT_VOICE, 'mode': 'whole-script'}), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
