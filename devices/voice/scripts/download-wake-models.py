#!/usr/bin/env python3
"""Download and verify the three pinned openWakeWord ONNX artifacts."""

from __future__ import annotations

import argparse
import hashlib
import os
import tempfile
import urllib.request
from pathlib import Path

RELEASE = "https://github.com/dscripka/openWakeWord/releases/download/v0.5.1"
MODELS = {
    "melspectrogram.onnx": "ba2b0e0f8b7b875369a2c89cb13360ff53bac436f2895cced9f479fa65eb176f",
    "embedding_model.onnx": "70d164290c1d095d1d4ee149bc5e00543250a7316b59f31d056cff7bd3075c1f",
    "hey_jarvis_v0.1.onnx": "94a13cfe60075b132f6a472e7e462e8123ee70861bc3fb58434a73712ee0d2cb",
}


def digest(path: Path) -> str:
    checksum = hashlib.sha256()
    with path.open("rb") as handle:
        while block := handle.read(1024 * 1024):
            checksum.update(block)
    return checksum.hexdigest()


def download(destination: Path) -> None:
    destination.mkdir(parents=True, exist_ok=True)
    for filename, expected in MODELS.items():
        target = destination / filename
        if target.is_file() and digest(target) == expected:
            print(f"verified {target}")
            continue
        descriptor, temporary_name = tempfile.mkstemp(prefix=f".{filename}.", dir=destination)
        os.close(descriptor)
        temporary = Path(temporary_name)
        try:
            print(f"downloading {filename}")
            urllib.request.urlretrieve(f"{RELEASE}/{filename}", temporary)
            actual = digest(temporary)
            if actual != expected:
                raise RuntimeError(
                    f"checksum mismatch for {filename}: expected {expected}, got {actual}"
                )
            os.replace(temporary, target)
        finally:
            temporary.unlink(missing_ok=True)


def main() -> None:
    default = Path(__file__).resolve().parents[1] / "models" / "openwakeword"
    parser = argparse.ArgumentParser()
    parser.add_argument("destination", nargs="?", type=Path, default=default)
    args = parser.parse_args()
    download(args.destination.expanduser().resolve())


if __name__ == "__main__":
    main()
