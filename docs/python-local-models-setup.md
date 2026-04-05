# Local Python Model Setup

The `kokoro_local` TTS provider and the `parakeet_local` ASR provider both invoke a long-running Python daemon over stdio (optionally through `ssh` for remote GPU boxes). This document covers the Python venv, package, and model setup required for each daemon to start successfully.

Each daemon can run in its own venv. The examples below put both venvs under `./.venvs/` inside the repo; you are free to place them anywhere as long as the `pythonBin` paths in your `agent-voice-adapter.json` point at the right interpreters.

The server does not download models itself. The first time a daemon starts, the underlying library (`kokoro` or `nemo_toolkit`) will fetch the configured model weights from the Hugging Face hub; keep that in mind when picking a host that can reach HF, and make sure the HF cache directory has enough disk space.

## System prerequisites

- Python 3.10+ (3.11 recommended)
- `ffmpeg` on `PATH` (required by the Parakeet daemon to normalize incoming audio to 16 kHz mono wav before inference)
- For GPU inference, a CUDA-capable driver/runtime that matches the PyTorch build you install. CPU-only is supported via `"device": "cpu"` or `"device": "auto"`.

## Kokoro TTS (`kokoro_local`)

Confirmed working versions (reference only — newer releases normally work):

- `kokoro==0.9.4`
- `torch==2.10.0`
- `numpy==2.4.2`

### Venv

```bash
python3 -m venv .venvs/kokoro
source .venvs/kokoro/bin/activate
pip install --upgrade pip wheel
# Install a CUDA or CPU build of torch first, per https://pytorch.org/get-started/locally/
pip install torch numpy
pip install kokoro
deactivate
```

### Model

The default model is `hexgrad/Kokoro-82M` with voice `af_heart` and language code `a` (English). The daemon passes these through to `KPipeline(lang_code=..., repo_id=..., device=...)`, which downloads the model on first use and caches it under `$HF_HOME` (default `~/.cache/huggingface`). To pre-download, run any small synthesis once or use the Hugging Face CLI.

### Config wiring

Point `kokoroLocal.pythonBin` at `<venv>/bin/python` and `kokoroLocal.scriptPath` at the repo's `scripts/kokoro_daemon.py`, and set `"tts": { "provider": "kokoro_local" }` in your `agent-voice-adapter.json` (the shipped default uses hosted ElevenLabs instead). See the full inline config example in the README for the structure. For a remote GPU host, add an `ssh` block (`target`, optional `port`, optional `identityFile`) and use absolute paths on the remote machine.

## Parakeet ASR (`parakeet_local`)

Confirmed working versions:

- `nemo-toolkit==2.6.2`
- `torch==2.10.0`
- `numpy==2.3.5`

### Venv

```bash
python3 -m venv .venvs/parakeet
source .venvs/parakeet/bin/activate
pip install --upgrade pip wheel
# Install a CUDA or CPU build of torch first, per https://pytorch.org/get-started/locally/
pip install torch numpy
pip install nemo_toolkit[asr]
deactivate
```

`nemo_toolkit[asr]` pulls in the ASR extras (including `torchmetrics`) needed by `nemo.collections.asr.models.ASRModel`. On some systems you may also need `Cython` and `packaging` preinstalled before `nemo_toolkit` will build — install them explicitly if pip complains.

### Model

The default model is `nvidia/parakeet-ctc-0.6b`. The daemon calls `ASRModel.from_pretrained(model_id, map_location=device)` on first use, which downloads the checkpoint to the Hugging Face / NeMo cache. No manual download step is required.

### Config wiring

Point `parakeetLocal.pythonBin` at `<venv>/bin/python` and `parakeetLocal.scriptPath` at the repo's `scripts/parakeet_daemon.py`, and set `"asr": { "provider": "parakeet_local" }` in your `agent-voice-adapter.json` (the shipped default uses hosted OpenAI Whisper instead). See the full inline config example in the README for the structure.

## Shared module layout

Both daemons import a small set of helpers from sibling files:

- `scripts/kokoro_daemon.py` and `scripts/kokoro_stream.py` import `scripts/kokoro_utils.py`
- `scripts/parakeet_daemon.py` and `scripts/parakeet_transcribe.py` import `scripts/parakeet_utils.py`

Python resolves these via `sys.path[0]` (the script's own directory), so `kokoro_utils.py` and `parakeet_utils.py` must live next to the daemon files. If you deploy the scripts directory to a remote machine over ssh, make sure the `*_utils.py` files are synced too.

## Verifying a daemon

You can smoke-test the Python side independently of the Node server by launching the daemon and typing (or piping in) a JSON request on stdin. Both daemons speak newline-delimited JSON over stdio; see `scripts/kokoro_daemon.py` and `scripts/parakeet_daemon.py` for the exact message shapes. If the daemon prints a `{"type":"ready",...}` line followed by inference output for a test request, your venv, torch install, and model download are all working.
