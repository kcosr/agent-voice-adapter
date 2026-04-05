#!/usr/bin/env python3
import argparse
import json
import os
import tempfile
import time
from pathlib import Path

from nemo.collections.asr.models import ASRModel

from parakeet_utils import convert_to_wav_16k_mono, extract_text_from_hypothesis

RESULT_PREFIX = "__PARAKEET_RESULT__="


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, help="Input audio path (wav/webm/etc)")
    parser.add_argument("--model", default="nvidia/parakeet-ctc-0.6b")
    parser.add_argument("--device", choices=["auto", "cuda", "cpu"], default="auto")
    parser.add_argument("--quiet", action="store_true")
    args = parser.parse_args()

    started_at = time.time()
    input_path = Path(args.input)
    if not input_path.exists():
        raise FileNotFoundError(f"Input file not found: {input_path}")

    with tempfile.TemporaryDirectory(prefix="parakeet-asr-") as tmp_dir:
        wav_path = Path(tmp_dir) / "input_16k.wav"
        convert_to_wav_16k_mono(input_path=input_path, output_path=wav_path)

        if args.device == "auto":
            import torch

            device = "cuda" if torch.cuda.is_available() else "cpu"
        else:
            device = args.device

        if args.quiet:
            os.environ.setdefault("NEMO_LOG_LEVEL", "ERROR")

        model = ASRModel.from_pretrained(args.model, map_location=device)
        hypotheses = model.transcribe([str(wav_path)])
        text = extract_text_from_hypothesis(hypotheses[0]) if hypotheses else ""

    payload = {
        "text": text,
        "modelId": args.model,
        "device": device,
        "durationMs": int((time.time() - started_at) * 1000),
    }
    print(RESULT_PREFIX + json.dumps(payload, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

