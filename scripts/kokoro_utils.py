import re

import numpy as np
import torch


def split_text(text: str, max_chars: int) -> list[str]:
    paragraphs = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]
    chunks: list[str] = []

    def push(value: str) -> None:
        normalized = re.sub(r"\s+", " ", value).strip()
        if normalized:
            chunks.append(normalized)

    for paragraph in paragraphs:
        if len(paragraph) <= max_chars:
            push(paragraph)
            continue

        sentences = re.split(r"(?<=[.!?])\s+", paragraph)
        current = ""
        for sentence in sentences:
            sentence = sentence.strip()
            if not sentence:
                continue

            combined = sentence if not current else f"{current} {sentence}"
            if len(combined) <= max_chars:
                current = combined
                continue

            if current:
                push(current)
                current = ""

            if len(sentence) <= max_chars:
                current = sentence
                continue

            words = sentence.split()
            segment = ""
            for word in words:
                expanded = word if not segment else f"{segment} {word}"
                if len(expanded) <= max_chars:
                    segment = expanded
                else:
                    push(segment)
                    segment = word
            push(segment)

        push(current)

    return chunks


def as_pcm16le_bytes(audio: torch.Tensor | np.ndarray) -> bytes:
    if isinstance(audio, torch.Tensor):
        data = audio.detach().float().cpu().numpy()
    else:
        data = np.asarray(audio, dtype=np.float32)

    mono = np.squeeze(data).astype(np.float32)
    clipped = np.clip(mono, -1.0, 1.0)
    int16 = (clipped * 32767.0).astype(np.int16)
    return int16.tobytes()
