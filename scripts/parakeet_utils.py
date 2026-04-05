import subprocess
from pathlib import Path


def convert_to_wav_16k_mono(input_path: Path, output_path: Path) -> None:
    command = [
        "ffmpeg",
        "-y",
        "-i",
        str(input_path),
        "-ac",
        "1",
        "-ar",
        "16000",
        str(output_path),
    ]
    completed = subprocess.run(command, capture_output=True, text=True)
    if completed.returncode != 0:
        raise RuntimeError(
            f"ffmpeg conversion failed (code={completed.returncode}): {completed.stderr.strip()}"
        )


def extract_text_from_hypothesis(item) -> str:
    if hasattr(item, "text"):
        return str(item.text)
    return str(item)
