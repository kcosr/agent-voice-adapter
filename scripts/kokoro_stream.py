#!/usr/bin/env python3
import argparse
import sys

import torch
from kokoro import KPipeline

from kokoro_utils import as_pcm16le_bytes, split_text


def run() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--text", required=True)
    parser.add_argument("--voice", default="af_heart")
    parser.add_argument("--model", default="hexgrad/Kokoro-82M")
    parser.add_argument("--lang", default="a")
    parser.add_argument("--speed", type=float, default=1.0)
    parser.add_argument("--device", choices=["auto", "cuda", "cpu"], default="auto")
    parser.add_argument("--max-chars", type=int, default=850)
    parser.add_argument("--gap-ms", type=int, default=0)
    args = parser.parse_args()

    if args.device == "auto":
        device = "cuda" if torch.cuda.is_available() else "cpu"
    else:
        device = args.device

    chunks = split_text(args.text, max(50, args.max_chars))
    if not chunks:
        return 0

    pipeline = KPipeline(lang_code=args.lang, repo_id=args.model, device=device)
    sample_rate = 24000
    if pipeline.model is not None and hasattr(pipeline.model, "sample_rate"):
        sample_rate = int(pipeline.model.sample_rate)
    gap_samples = max(0, int(sample_rate * (max(0, args.gap_ms) / 1000.0)))
    gap = np.zeros(gap_samples, dtype=np.int16).tobytes() if gap_samples > 0 else b""

    for index, chunk in enumerate(chunks):
        for result in pipeline(chunk, voice=args.voice, speed=args.speed, split_pattern=None):
            if result.audio is None:
                continue

            payload = as_pcm16le_bytes(result.audio)
            if payload:
                sys.stdout.buffer.write(payload)
                sys.stdout.buffer.flush()

        if gap and index + 1 < len(chunks):
            sys.stdout.buffer.write(gap)
            sys.stdout.buffer.flush()

    return 0


if __name__ == "__main__":
    raise SystemExit(run())

