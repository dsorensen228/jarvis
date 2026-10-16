import unittest

import numpy as np

from app import build_jarvis_voice


class FakeVoiceModel:
    def __init__(self, voices):
        self.voices = voices

    def get_voice_style(self, name):
        return self.voices[name]


class JarvisVoiceTests(unittest.TestCase):
    def test_blends_george_and_daniel(self):
        model = FakeVoiceModel(
            {
                "bm_george": np.full((2, 3), 2.0, dtype=np.float32),
                "bm_daniel": np.full((2, 3), 6.0, dtype=np.float32),
            }
        )

        voice = build_jarvis_voice(model)

        np.testing.assert_allclose(voice, np.full((2, 3), 3.4, dtype=np.float32))
        self.assertEqual(voice.dtype, np.float32)

    def test_rejects_incompatible_voice_shapes(self):
        model = FakeVoiceModel(
            {
                "bm_george": np.zeros((2, 3), dtype=np.float32),
                "bm_daniel": np.zeros((3, 2), dtype=np.float32),
            }
        )

        with self.assertRaisesRegex(RuntimeError, "incompatible shapes"):
            build_jarvis_voice(model)


if __name__ == "__main__":
    unittest.main()
