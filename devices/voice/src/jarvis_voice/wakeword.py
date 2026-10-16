"""One local ONNX wake-word model: Hey Jarvis."""

from __future__ import annotations

from pathlib import Path

import numpy as np


class WakeWordDetector:
    def __init__(self, model_dir: Path, threshold: float, consecutive_hits: int) -> None:
        paths = {
            "wake": model_dir / "hey_jarvis_v0.1.onnx",
            "melspec": model_dir / "melspectrogram.onnx",
            "embedding": model_dir / "embedding_model.onnx",
        }
        missing = [str(path) for path in paths.values() if not path.is_file()]
        if missing:
            raise FileNotFoundError("openWakeWord model files are missing: " + ", ".join(missing))

        from openwakeword.model import Model

        self._model = Model(
            wakeword_models=[str(paths["wake"])],
            inference_framework="onnx",
            melspec_model_path=str(paths["melspec"]),
            embedding_model_path=str(paths["embedding"]),
            enable_speex_noise_suppression=False,
            vad_threshold=0,
        )
        self._threshold = threshold
        self._required_hits = consecutive_hits
        self._hits = 0

    def process(self, pcm: bytes) -> bool:
        samples = np.frombuffer(pcm, dtype="<i2")
        predictions = self._model.predict(samples)
        score = max((float(value) for value in predictions.values()), default=0.0)
        self._hits = self._hits + 1 if score >= self._threshold else 0
        if self._hits < self._required_hits:
            return False
        self.reset()
        return True

    def reset(self) -> None:
        self._hits = 0
        reset = getattr(self._model, "reset", None)
        if callable(reset):
            reset()
