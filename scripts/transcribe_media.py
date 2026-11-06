#!/usr/bin/env python3
from __future__ import annotations

import argparse
import fcntl
import json
import math
import os
import shutil
import subprocess
import sys
import tempfile
import time
import wave
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator, Optional


WHISPER_VERSION = "v1.9.1"
MODEL_NAME = "large-v3"
BACKENDS = ("auto", "cpu", "vulkan", "hip", "metal")
GPU_BACKENDS = {"vulkan", "hip", "metal"}
DEFAULT_OUTPUT_DIR = Path.home() / ".cache" / "shorts-studio" / "transcripts"


class TranscriptionError(Exception):
    pass


def cache_root() -> Path:
    if value := os.environ.get("WHISPER_CPP_HOME"):
        return Path(value).expanduser()
    if value := os.environ.get("XDG_CACHE_HOME"):
        return Path(value).expanduser() / "whisper.cpp"
    return Path.home() / ".cache" / "whisper.cpp"


def default_model_path() -> Path:
    if value := os.environ.get("WHISPER_MODEL_PATH"):
        return Path(value).expanduser()
    return cache_root() / "models" / f"ggml-{MODEL_NAME}.bin"


def active_backend() -> str:
    path = cache_root() / "active-backend"
    try:
        backend = path.read_text(encoding="utf-8").strip()
    except OSError:
        return ""
    return backend if backend in BACKENDS[1:] else ""


def backend_order(requested: str) -> tuple[str, ...]:
    if requested != "auto":
        return (requested,)

    if sys.platform == "darwin":
        defaults = ("metal", "cpu", "vulkan", "hip")
    else:
        defaults = ("vulkan", "cpu", "hip", "metal")

    active = active_backend()
    if active:
        return (active,) + tuple(backend for backend in defaults if backend != active)
    return defaults


def default_binary_candidates(requested: str) -> list[tuple[Path, str]]:
    root = cache_root() / "builds" / WHISPER_VERSION
    candidates: list[tuple[Path, str]] = []
    for backend in backend_order(requested):
        candidates.append((root / backend / "bin" / "whisper-cli", backend))
        candidates.append((root / backend / "bin" / "Release" / "whisper-cli", backend))
    return candidates


def resolve_binary(
    explicit: Optional[Path], backend: str, use_environment: bool = True
) -> tuple[Path, str]:
    if explicit is not None:
        candidates = [(explicit.expanduser(), backend if backend != "auto" else "custom")]
    elif use_environment and (value := os.environ.get("WHISPER_CPP_BIN")):
        candidates = [(Path(value).expanduser(), backend if backend != "auto" else "custom")]
    else:
        candidates = default_binary_candidates(backend)

    for candidate, candidate_backend in candidates:
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return candidate.resolve(), candidate_backend

    checked = "\n  ".join(str(path) for path, _ in candidates)
    raise TranscriptionError(
        "whisper-cli was not found. Run setup_whisper.sh first. Checked:\n"
        f"  {checked}"
    )


def positive_int(value: str) -> int:
    parsed = int(value)
    if parsed < 1:
        raise argparse.ArgumentTypeError("must be greater than zero")
    return parsed


def nonnegative_int(value: str) -> int:
    parsed = int(value)
    if parsed < 0:
        raise argparse.ArgumentTypeError("must not be negative")
    return parsed


def positive_float(value: str) -> float:
    parsed = float(value)
    if not math.isfinite(parsed) or parsed <= 0:
        raise argparse.ArgumentTypeError("must be a finite number greater than zero")
    return parsed


def parse_args() -> argparse.Namespace:
    default_threads = min(16, max(1, (os.cpu_count() or 4) // 2))
    parser = argparse.ArgumentParser(
        description=(
            "Transcribe a local audio or video file with whisper.cpp and write "
            "TXT, SRT and JSON outputs."
        )
    )
    parser.add_argument("input", type=Path, help="local audio or video file")
    parser.add_argument(
        "--backend",
        choices=BACKENDS,
        default="auto",
        help="compute backend (default: auto)",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=DEFAULT_OUTPUT_DIR,
        help=f"output directory (default: {DEFAULT_OUTPUT_DIR})",
    )
    parser.add_argument(
        "--language",
        default="auto",
        help="spoken language code or 'auto' (default: auto)",
    )
    parser.add_argument(
        "--prompt",
        help="initial prompt with names, abbreviations or domain terminology",
    )
    parser.add_argument(
        "--threads",
        type=positive_int,
        default=default_threads,
        help=f"compute threads (default: {default_threads})",
    )
    parser.add_argument(
        "--max-context",
        type=nonnegative_int,
        help="maximum retained text context tokens; use 0 to disable context",
    )
    parser.add_argument(
        "--model",
        type=Path,
        default=default_model_path(),
        help=f"ggml model path (default: {default_model_path()})",
    )
    parser.add_argument(
        "--whisper-bin",
        type=Path,
        help="path to whisper-cli (overrides project cache discovery)",
    )
    parser.add_argument(
        "--gpu-timeout",
        type=positive_float,
        help="GPU transcription timeout in seconds (default: based on audio duration)",
    )
    parser.add_argument(
        "--no-fallback",
        action="store_true",
        help="do not retry on CPU when an auto-selected GPU backend fails",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="replace existing output files after successful transcription",
    )
    return parser.parse_args()


def run_checked(
    command: list[str],
    description: str,
    cwd: Optional[Path] = None,
    timeout: Optional[float] = None,
) -> None:
    try:
        subprocess.run(command, cwd=cwd, check=True, timeout=timeout)
    except FileNotFoundError as error:
        raise TranscriptionError(f"{description} failed: {error.filename} was not found") from error
    except subprocess.CalledProcessError as error:
        raise TranscriptionError(
            f"{description} failed with exit code {error.returncode}"
        ) from error
    except subprocess.TimeoutExpired as error:
        raise TranscriptionError(
            f"{description} exceeded the {timeout:g}-second timeout"
        ) from error


def normalize_json_model_path(path: Path) -> None:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise TranscriptionError(f"invalid JSON output {path}: {error}") from error

    params = data.get("params")
    if isinstance(params, dict) and isinstance(params.get("model"), str):
        params["model"] = Path(params["model"]).name
        path.write_text(
            json.dumps(data, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )


def wav_duration(path: Path) -> float:
    try:
        with wave.open(str(path), "rb") as audio:
            return audio.getnframes() / audio.getframerate()
    except (OSError, wave.Error, ZeroDivisionError) as error:
        raise TranscriptionError(f"could not determine WAV duration: {error}") from error


def generated_outputs(base: Path) -> list[Path]:
    return [base.with_suffix(extension) for extension in (".txt", ".srt", ".json")]


def run_whisper(
    whisper_bin: Path,
    backend: str,
    model: Path,
    wav_path: Path,
    output_base: Path,
    language: str,
    threads: int,
    prompt: Optional[str],
    max_context: Optional[int],
    timeout: Optional[float],
) -> list[Path]:
    command = [
        str(whisper_bin),
        "--model",
        model.name,
        "--file",
        str(wav_path),
        "--language",
        language,
        "--threads",
        str(threads),
        "--output-txt",
        "--output-srt",
        "--output-json",
        "--output-file",
        str(output_base),
        "--print-progress",
    ]
    if prompt:
        command.extend(["--prompt", prompt])
    if max_context is not None:
        command.extend(["--max-context", str(max_context)])

    run_checked(
        command,
        f"{backend} transcription",
        cwd=model.parent,
        timeout=timeout,
    )

    generated = generated_outputs(output_base)
    missing = [path for path in generated if not path.is_file()]
    if missing:
        formatted = "\n  ".join(str(path) for path in missing)
        raise TranscriptionError(
            f"whisper-cli did not create expected files:\n  {formatted}"
        )
    normalize_json_model_path(generated[-1])
    return generated


def activate_backend(backend: str) -> None:
    root = cache_root()
    root.mkdir(parents=True, exist_ok=True)
    temporary = root / f"active-backend.part.{os.getpid()}.{time.time_ns()}"
    temporary.write_text(f"{backend}\n", encoding="utf-8")
    temporary.replace(root / "active-backend")


def record_backend_result(
    backend: str, model: Path, fallback_from: Optional[str] = None
) -> None:
    root = cache_root()
    root.mkdir(parents=True, exist_ok=True)
    profile = {
        "whisper_version": WHISPER_VERSION,
        "model": model.name,
        "backend": backend,
        "status": "fallback" if fallback_from else "ok",
        "fallback_from": fallback_from,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }
    temporary = root / f"backend-profile.json.part.{os.getpid()}.{time.time_ns()}"
    temporary.write_text(
        json.dumps(profile, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    temporary.replace(root / "backend-profile.json")


@contextmanager
def output_lock(path: Path) -> Iterator[None]:
    with path.open("a+", encoding="utf-8") as lock_file:
        try:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise TranscriptionError(
                f"another transcription is writing the same outputs: {path}"
            ) from error
        yield


def publish_outputs(
    generated: list[Path], destinations: list[Path], force: bool, temporary_dir: Path
) -> None:
    installed: list[Path] = []
    backups: list[tuple[Path, Path]] = []

    try:
        if force:
            backup_dir = temporary_dir / "backups"
            backup_dir.mkdir()
            for index, destination in enumerate(destinations):
                if destination.exists():
                    if not destination.is_file():
                        raise TranscriptionError(
                            f"output path exists but is not a file: {destination}"
                        )
                    backup = backup_dir / f"{index}-{destination.name}"
                    destination.replace(backup)
                    backups.append((backup, destination))

            for generated_path, destination in zip(generated, destinations):
                generated_path.replace(destination)
                installed.append(destination)
        else:
            for generated_path, destination in zip(generated, destinations):
                try:
                    os.link(generated_path, destination)
                except FileExistsError as error:
                    raise TranscriptionError(
                        f"output file appeared during transcription: {destination}"
                    ) from error
                installed.append(destination)
    except BaseException:
        for destination in installed:
            destination.unlink(missing_ok=True)
        for backup, destination in backups:
            backup.replace(destination)
        raise


def transcribe(args: argparse.Namespace) -> tuple[list[Path], str]:
    source = args.input.expanduser()
    if not source.is_file():
        raise TranscriptionError(f"input file does not exist: {source}")
    source = source.resolve()

    model = args.model.expanduser()
    if not model.is_file():
        raise TranscriptionError(
            f"model does not exist: {model}. Run setup_whisper.sh first."
        )
    model = model.resolve()

    whisper_bin, selected_backend = resolve_binary(args.whisper_bin, args.backend)
    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg is None:
        raise TranscriptionError("ffmpeg was not found in PATH")

    output_dir = args.output_dir.expanduser()
    if output_dir.exists() and not output_dir.is_dir():
        raise TranscriptionError(f"output path is not a directory: {output_dir}")
    output_dir.mkdir(parents=True, exist_ok=True)
    output_dir = output_dir.resolve()

    destinations = [
        output_dir / f"{source.stem}{extension}"
        for extension in (".txt", ".srt", ".json")
    ]
    lock_path = output_dir / f".{source.stem}.whisper.lock"
    with output_lock(lock_path):
        existing = [path for path in destinations if path.exists()]
        if existing and not args.force:
            formatted = "\n  ".join(str(path) for path in existing)
            raise TranscriptionError(
                "output files already exist; use --force to replace them:\n"
                f"  {formatted}"
            )

        with tempfile.TemporaryDirectory(
            prefix=".shorts-whisper-", dir=output_dir
        ) as temporary:
            temporary_dir = Path(temporary)
            wav_path = temporary_dir / "input.wav"
            run_checked(
                [
                    ffmpeg,
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-y",
                    "-i",
                    str(source),
                    "-vn",
                    "-ar",
                    "16000",
                    "-ac",
                    "1",
                    "-c:a",
                    "pcm_s16le",
                    str(wav_path),
                ],
                "audio conversion",
            )

            duration = wav_duration(wav_path)
            gpu_timeout = args.gpu_timeout or max(120.0, duration * 0.5)
            timeout = gpu_timeout if selected_backend in GPU_BACKENDS else None
            fallback_from: Optional[str] = None

            try:
                generated = run_whisper(
                    whisper_bin,
                    selected_backend,
                    model,
                    wav_path,
                    temporary_dir / f"transcript-{selected_backend}",
                    args.language,
                    args.threads,
                    args.prompt,
                    args.max_context,
                    timeout,
                )
            except TranscriptionError as gpu_error:
                fallback_allowed = (
                    args.backend == "auto"
                    and selected_backend in GPU_BACKENDS
                    and args.whisper_bin is None
                    and not os.environ.get("WHISPER_CPP_BIN")
                    and not args.no_fallback
                )
                if not fallback_allowed:
                    raise

                print(
                    f"warning: {gpu_error}; retrying with CPU",
                    file=sys.stderr,
                )
                try:
                    cpu_bin, result_backend = resolve_binary(
                        None, "cpu", use_environment=False
                    )
                    generated = run_whisper(
                        cpu_bin,
                        result_backend,
                        model,
                        wav_path,
                        temporary_dir / "transcript-cpu-fallback",
                        args.language,
                        args.threads,
                        args.prompt,
                        args.max_context,
                        None,
                    )
                except TranscriptionError as cpu_error:
                    raise TranscriptionError(
                        f"{gpu_error}; CPU fallback also failed: {cpu_error}"
                    ) from cpu_error
                fallback_from = selected_backend
                selected_backend = result_backend

            publish_outputs(generated, destinations, args.force, temporary_dir)

    try:
        if fallback_from:
            activate_backend(selected_backend)
        record_backend_result(selected_backend, model, fallback_from)
    except OSError as error:
        print(f"warning: could not update backend profile: {error}", file=sys.stderr)

    return destinations, selected_backend


def main() -> int:
    try:
        outputs, backend = transcribe(parse_args())
    except (TranscriptionError, OSError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1

    print(f"Transcription complete with {backend}:")
    for output in outputs:
        print(f"  {output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
