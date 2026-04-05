#!/usr/bin/env python3
import argparse
import base64
import json
import os
import sys
import tempfile
import time
import traceback
from pathlib import Path

from nemo.collections.asr.models import ASRModel

from parakeet_utils import convert_to_wav_16k_mono, extract_text_from_hypothesis


def emit(payload: dict) -> None:
    print(json.dumps(payload, separators=(",", ":")), flush=True)


def infer_extension(mime_type: str | None) -> str:
    normalized = (mime_type or "").lower()
    if "webm" in normalized:
        return "webm"
    if "wav" in normalized or "wave" in normalized:
        return "wav"
    if "mpeg" in normalized or "mp3" in normalized:
        return "mp3"
    if "ogg" in normalized:
        return "ogg"
    return "bin"


def resolve_device(value: str) -> str:
    raw = (value or "auto").strip().lower()
    if raw == "auto":
        import torch

        return "cuda" if torch.cuda.is_available() else "cpu"
    if raw in {"cuda", "cpu"}:
        return raw
    return "cpu"


class ModelCache:
    def __init__(self, quiet: bool) -> None:
        self._key: tuple[str, str] | None = None
        self._model = None
        self._quiet = quiet

    def get(self, model_id: str, device: str):
        key = (model_id, device)
        if self._model is not None and self._key == key:
            return self._model

        if self._quiet:
            os.environ.setdefault("NEMO_LOG_LEVEL", "ERROR")

        self._model = ASRModel.from_pretrained(model_id, map_location=device)
        self._key = key
        return self._model


def handle_transcribe(cache: ModelCache, message: dict, default_model: str, default_device: str) -> None:
    request_id = str(message.get("request_id", "")).strip()
    if not request_id:
        emit({"type": "error", "request_id": "", "error": "missing request_id"})
        return

    audio_base64 = str(message.get("audio_base64", "")).strip()
    if not audio_base64:
        emit({"type": "error", "request_id": request_id, "error": "missing audio_base64"})
        return

    started_at = time.time()
    model_id = str(message.get("model") or default_model).strip() or default_model
    device = resolve_device(str(message.get("device") or default_device))
    mime_type = str(message.get("mime_type", "")).strip() or None

    emit(
        {
            "type": "started",
            "request_id": request_id,
            "model_id": model_id,
            "device": device,
        }
    )

    try:
        audio_bytes = base64.b64decode(audio_base64)
    except Exception:
        emit({"type": "error", "request_id": request_id, "error": "invalid base64 audio payload"})
        return

    extension = infer_extension(mime_type)

    with tempfile.TemporaryDirectory(prefix="parakeet-daemon-") as tmp_dir:
        input_path = Path(tmp_dir) / f"input.{extension}"
        wav_path = Path(tmp_dir) / "input_16k.wav"
        input_path.write_bytes(audio_bytes)
        convert_to_wav_16k_mono(input_path=input_path, output_path=wav_path)

        model = cache.get(model_id=model_id, device=device)
        hypotheses = model.transcribe([str(wav_path)])

    text = extract_text_from_hypothesis(hypotheses[0]) if hypotheses else ""
    duration_ms = int((time.time() - started_at) * 1000)
    emit(
        {
            "type": "result",
            "request_id": request_id,
            "text": text,
            "model_id": model_id,
            "device": device,
            "duration_ms": duration_ms,
        }
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default="nvidia/parakeet-ctc-0.6b")
    parser.add_argument("--device", choices=["auto", "cuda", "cpu"], default="auto")
    parser.add_argument("--quiet", action="store_true")
    parser.add_argument("--warmup", action="store_true")
    args = parser.parse_args()

    default_model = args.model
    default_device = resolve_device(args.device)
    cache = ModelCache(quiet=args.quiet)

    if args.warmup:
        cache.get(model_id=default_model, device=default_device)

    emit(
        {
            "type": "ready",
            "model_id": default_model,
            "device": default_device,
            "warmed": bool(args.warmup),
        }
    )

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            message = json.loads(line)
        except Exception:
            emit({"type": "error", "request_id": "", "error": "invalid_json"})
            continue

        msg_type = str(message.get("type", "")).strip()
        if msg_type == "ping":
            emit({"type": "pong"})
            continue

        if msg_type != "transcribe":
            emit({"type": "error", "request_id": "", "error": f"unsupported_type:{msg_type}"})
            continue

        try:
            handle_transcribe(
                cache=cache,
                message=message,
                default_model=default_model,
                default_device=default_device,
            )
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
