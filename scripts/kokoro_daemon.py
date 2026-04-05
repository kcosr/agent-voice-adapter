#!/usr/bin/env python3
import base64
import json
import sys
import traceback

import torch
from kokoro import KPipeline

from kokoro_utils import as_pcm16le_bytes, split_text


def emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, separators=(",", ":")) + "\n")
    sys.stdout.flush()


class PipelineCache:
    def __init__(self) -> None:
        self._key = None
        self._pipeline = None

    def get(self, model: str, lang: str, device: str) -> KPipeline:
        key = (model, lang, device)
        if self._pipeline is not None and key == self._key:
            return self._pipeline

        self._pipeline = KPipeline(lang_code=lang, repo_id=model, device=device)
        self._key = key
        return self._pipeline


def normalize_device(value: str) -> str:
    raw = (value or "auto").strip().lower()
    if raw == "auto":
        return "cuda" if torch.cuda.is_available() else "cpu"
    if raw in {"cuda", "cpu"}:
        return raw
    return "cpu"


def handle_synthesize(cache: PipelineCache, request: dict) -> None:
    request_id = str(request.get("request_id", ""))
    if not request_id:
        emit({"type": "error", "request_id": "", "error": "missing request_id"})
        return

    text = str(request.get("text", "")).strip()
    if not text:
        emit({"type": "done", "request_id": request_id})
        return

    voice = str(request.get("voice", "af_heart"))
    model = str(request.get("model", "hexgrad/Kokoro-82M"))
    lang = str(request.get("lang", "a"))
    speed = float(request.get("speed", 1.0))
    device = normalize_device(str(request.get("device", "auto")))
    max_chars = max(50, int(request.get("max_chars", 850)))
    gap_ms = max(0, int(request.get("gap_ms", 0)))

    pipeline = cache.get(model=model, lang=lang, device=device)
    chunks = split_text(text, max_chars=max_chars)
    if not chunks:
        emit({"type": "done", "request_id": request_id})
        return

    sample_rate = 24000
    if pipeline.model is not None and hasattr(pipeline.model, "sample_rate"):
        sample_rate = int(pipeline.model.sample_rate)

    emit(
        {
            "type": "started",
            "request_id": request_id,
            "model": model,
            "voice": voice,
            "lang": lang,
            "speed": speed,
            "device": device,
            "sample_rate": sample_rate,
            "max_chars": max_chars,
            "gap_ms": gap_ms,
            "chunk_count": len(chunks),
        }
    )
    gap_samples = int(sample_rate * (gap_ms / 1000.0))
    gap = np.zeros(gap_samples, dtype=np.int16).tobytes() if gap_samples > 0 else b""

    for index, chunk in enumerate(chunks):
        for result in pipeline(chunk, voice=voice, speed=speed, split_pattern=None):
            if result.audio is None:
                continue
            payload = as_pcm16le_bytes(result.audio)
            if not payload:
                continue
            emit(
                {
                    "type": "audio",
                    "request_id": request_id,
                    "chunk_base64": base64.b64encode(payload).decode("ascii"),
                }
            )

        if gap and index + 1 < len(chunks):
            emit(
                {
                    "type": "audio",
                    "request_id": request_id,
                    "chunk_base64": base64.b64encode(gap).decode("ascii"),
                }
            )

    emit({"type": "done", "request_id": request_id})


def main() -> int:
    cache = PipelineCache()
    emit({"type": "ready"})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            message = json.loads(line)
        except Exception:
            emit({"type": "error", "request_id": "", "error": "invalid_json"})
            continue

        msg_type = str(message.get("type", ""))
        if msg_type == "ping":
            emit({"type": "pong"})
            continue
        if msg_type != "synthesize":
            emit({"type": "error", "request_id": "", "error": f"unsupported_type:{msg_type}"})
            continue

        try:
            handle_synthesize(cache, message)
        except Exception as exc:
            emit(
                {
                    "type": "error",
                    "request_id": str(message.get("request_id", "")),
                    "error": str(exc),
                    "traceback": traceback.format_exc(limit=3),
                }
            )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
