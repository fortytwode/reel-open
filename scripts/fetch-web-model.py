#!/usr/bin/env python3
"""Fetch and verify the optional browser camera-effects model."""

import hashlib
from pathlib import Path
import tempfile
from urllib.request import urlopen


URL = ("https://storage.googleapis.com/mediapipe-models/image_segmenter/"
       "selfie_segmenter/float16/1/selfie_segmenter.tflite")
SIZE = 249537
SHA256 = "191ac9529ae506ee0beefa6b2c945a172dab9d07d1e802a290a4e4038226658b"
MODEL = Path(__file__).resolve().parent.parent / "web/vendor/mediapipe/selfie_segmenter.tflite"


def valid(model):
    return len(model) == SIZE and hashlib.sha256(model).hexdigest() == SHA256


def main():
    try:
        if MODEL.is_symlink() or (MODEL.exists() and not MODEL.is_file()):
            raise OSError("model destination must be a regular file")
        if MODEL.is_file() and MODEL.stat().st_size == SIZE and valid(MODEL.read_bytes()):
            print(f"Verified {MODEL}")
            return

        with urlopen(URL, timeout=30) as response:
            model = response.read(SIZE + 1)
        if not valid(model):
            raise ValueError("download failed the pinned size or SHA-256 check")

        with tempfile.NamedTemporaryFile(dir=MODEL.parent, prefix=".selfie_segmenter.", delete=False) as output:
            staging = Path(output.name)
            try:
                output.write(model)
                output.close()
                staging.chmod(0o644)
                staging.replace(MODEL)
            finally:
                staging.unlink(missing_ok=True)
    except (OSError, ValueError) as error:
        raise SystemExit(f"Model fetch failed: {error}") from None
    print(f"Downloaded and verified {MODEL}")


if __name__ == "__main__":
    main()
