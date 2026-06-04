#!/usr/bin/env python3
import base64
import json
import sys
import threading
import traceback
from pathlib import Path
from typing import Any

import numpy as np
import torch
from pocket_tts import TTSModel


def emit(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def as_pcm16le_bytes(audio: torch.Tensor | np.ndarray) -> bytes:
    if isinstance(audio, torch.Tensor):
        data = audio.detach().float().cpu().numpy()
    else:
        data = np.asarray(audio, dtype=np.float32)

    mono = np.squeeze(data).astype(np.float32)
    clipped = np.clip(mono, -1.0, 1.0)
    int16 = (clipped * 32767.0).astype(np.int16)
    return int16.tobytes()


def optional_int(value: Any) -> int | None:
    if value is None or value == "":
        return None
    try:
        parsed = int(value)
    except Exception:
        return None
    return parsed if parsed > 0 else None


def optional_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    return str(value or "").strip().lower() in {"1", "true", "yes", "on"}


def normalize_device(value: Any) -> str:
    raw = str(value or "cpu").strip().lower()
    if raw == "auto":
        if torch.cuda.is_available():
            return "cuda"
        if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
            return "mps"
        return "cpu"
    if raw == "cuda" or raw.startswith("cuda:") or raw in {"cpu", "mps"}:
        return raw
    return "cpu"


class ModelCache:
    def __init__(self) -> None:
        self._model_key: tuple[str | None, str | None, str, bool] | None = None
        self._model: TTSModel | None = None
        self._voice_key: tuple[tuple[str | None, str | None, str, bool], str] | None = None
        self._voice_state: dict[str, Any] | None = None

    def get_model(
        self,
        language: str | None,
        config_path: str | None,
        device: str,
        quantize: bool,
    ) -> TTSModel:
        key = (language, config_path, device, quantize)
        if self._model is not None and self._model_key == key:
            return self._model

        model = TTSModel.load_model(language=language, config=config_path, quantize=quantize)
        model.to(device)
        self._model = model
        self._model_key = key
        self._voice_key = None
        self._voice_state = None
        return model

    def get_voice_state(self, model: TTSModel, voice: str) -> dict[str, Any]:
        if self._model_key is None:
            raise RuntimeError("model key missing")
        key = (self._model_key, voice)
        if self._voice_state is not None and self._voice_key == key:
            return self._voice_state

        state = model.get_state_for_audio_prompt(voice)
        self._voice_state = state
        self._voice_key = key
        return state


class ActiveRequest:
    def __init__(self, request_id: str) -> None:
        self.request_id = request_id
        self.cancel_event = threading.Event()


class DaemonState:
    def __init__(self) -> None:
        self.cache = ModelCache()
        self.lock = threading.Lock()
        self.active: ActiveRequest | None = None

    def start(self, request: dict[str, Any]) -> bool:
        request_id = str(request.get("request_id", ""))
        if not request_id:
            emit({"type": "error", "request_id": "", "error": "missing request_id"})
            return False

        with self.lock:
            if self.active is not None:
                emit(
                    {
                        "type": "error",
                        "request_id": request_id,
                        "error": "busy",
                    }
                )
                return False
            self.active = ActiveRequest(request_id)

        thread = threading.Thread(target=self._run_synthesize, args=(request,), daemon=True)
        thread.start()
        return True

    def cancel(self, request_id: str) -> None:
        with self.lock:
            active = self.active
        if active is not None and active.request_id == request_id:
            active.cancel_event.set()

    def _clear_active(self, request_id: str) -> None:
        with self.lock:
            if self.active is not None and self.active.request_id == request_id:
                self.active = None

    def _active_for(self, request_id: str) -> ActiveRequest | None:
        with self.lock:
            active = self.active
        if active is not None and active.request_id == request_id:
            return active
        return None

    def _run_synthesize(self, request: dict[str, Any]) -> None:
        request_id = str(request.get("request_id", ""))
        try:
            self._handle_synthesize(request)
        except Exception as exc:
            emit(
                {
                    "type": "error",
                    "request_id": request_id,
                    "error": str(exc),
                    "traceback": traceback.format_exc(limit=3),
                }
            )
        finally:
            self._clear_active(request_id)

    def _handle_synthesize(self, request: dict[str, Any]) -> None:
        request_id = str(request.get("request_id", ""))
        active = self._active_for(request_id)
        if active is None:
            return

        text = str(request.get("text", "")).strip()
        if not text:
            emit({"type": "done", "request_id": request_id})
            return

        voice = str(request.get("voice", "alba")).strip() or "alba"
        model_value = str(request.get("model", "")).strip()
        language = str(request.get("language", "english")).strip() or "english"
        config_path = str(request.get("config_path", "") or "").strip() or None
        if model_value.endswith((".yaml", ".yml")) and config_path is None:
            config_path = model_value
        elif model_value and not config_path:
            language = model_value

        if config_path:
            language_for_load = None
            config_for_load = str(Path(config_path).expanduser())
        else:
            language_for_load = language
            config_for_load = None

        device = normalize_device(request.get("device", "cpu"))
        quantize = optional_bool(request.get("quantize", False))
        max_tokens = optional_int(request.get("max_tokens")) or 50
        frames_after_eos = optional_int(request.get("frames_after_eos"))

        if active.cancel_event.is_set():
            emit({"type": "canceled", "request_id": request_id})
            return

        model = self.cache.get_model(
            language=language_for_load,
            config_path=config_for_load,
            device=device,
            quantize=quantize,
        )

        if active.cancel_event.is_set():
            emit({"type": "canceled", "request_id": request_id})
            return

        voice_state = self.cache.get_voice_state(model, voice)

        emit(
            {
                "type": "started",
                "request_id": request_id,
                "model": model_value or config_path or language,
                "voice": voice,
                "language": language,
                "config_path": config_path,
                "device": str(model.device),
                "quantize": quantize,
                "sample_rate": int(model.sample_rate),
                "max_tokens": max_tokens,
                "frames_after_eos": frames_after_eos,
            }
        )

        for chunk in model.generate_audio_stream(
            model_state=voice_state,
            text_to_generate=text,
            max_tokens=max_tokens,
            frames_after_eos=frames_after_eos,
            copy_state=True,
        ):
            if active.cancel_event.is_set():
                emit({"type": "canceled", "request_id": request_id})
                return

            payload = as_pcm16le_bytes(chunk)
            if not payload:
                continue
            emit(
                {
                    "type": "audio",
                    "request_id": request_id,
                    "chunk_base64": base64.b64encode(payload).decode("ascii"),
                }
            )

        if active.cancel_event.is_set():
            emit({"type": "canceled", "request_id": request_id})
            return

        emit({"type": "done", "request_id": request_id})


def main() -> int:
    state = DaemonState()
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
        if msg_type == "cancel":
            state.cancel(str(message.get("request_id", "")))
            continue
        if msg_type == "synthesize":
            state.start(message)
            continue

        emit({"type": "error", "request_id": "", "error": f"unsupported_type:{msg_type}"})

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
