import importlib.util
import pathlib
import tempfile
import unittest
from unittest.mock import patch

import edge_tts

SPEC = importlib.util.spec_from_file_location(
    'edge_adapter', pathlib.Path(__file__).resolve().parents[1] / 'scripts' / 'edge-tts-server.py')
ADAPTER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ADAPTER)


class FakeCommunicate(edge_tts.Communicate):
    requests = []

    async def stream(self):
        for text in self.texts:
            self.requests.append(text)
            yield {'type': 'audio', 'data': b'audio-fixture' * 200}
            yield {'type': 'WordBoundary', 'text': '开始', 'offset': 0, 'duration': 2_000_000}
            yield {'type': 'WordBoundary', 'text': '十五', 'offset': 100_000_000, 'duration': 3_000_000}


class WholeScriptTests(unittest.IsolatedAsyncioTestCase):
    async def test_long_script_is_one_request_with_native_times_and_cached_bytes(self):
        text = '这是完整讲解。' * 220 + '最后的答案是十五。'
        self.assertGreater(len(text.encode()), 4096)
        FakeCommunicate.requests = []
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(ADAPTER, 'CACHE', pathlib.Path(directory)), \
                patch.object(ADAPTER.edge_tts, 'Communicate', FakeCommunicate):
            audio, words, cached = await ADAPTER.synthesize(text, ADAPTER.DEFAULT_VOICE, '+0%', ADAPTER.digest(text.encode()))
            self.assertFalse(cached)
            self.assertEqual(FakeCommunicate.requests, [text.encode()])
            self.assertEqual(words['words'][-1], {'text': '十五', 'start': 10, 'end': 10.3})
            self.assertEqual(words['synthesisRequests'], 1)
            second_audio, second_words, cached = await ADAPTER.synthesize(text, ADAPTER.DEFAULT_VOICE, '+0%', ADAPTER.digest(text.encode()))
            self.assertTrue(cached)
            self.assertEqual(second_audio, audio)
            self.assertEqual(second_words, words)
            self.assertEqual(len(FakeCommunicate.requests), 1)

    async def test_oversized_message_is_rejected_before_sending(self):
        FakeCommunicate.requests = []
        with patch.object(ADAPTER.edge_tts, 'Communicate', FakeCommunicate):
            with self.assertRaisesRegex(ValueError, 'single-message limit'):
                ADAPTER.whole_script_communicator('讲解' * 12000, ADAPTER.DEFAULT_VOICE, '+0%')
        self.assertEqual(FakeCommunicate.requests, [])


if __name__ == '__main__':
    unittest.main()
