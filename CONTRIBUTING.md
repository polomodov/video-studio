# Contributing

Shorts Studio is a small Node.js application with browser JavaScript and Python standard-library helpers. It currently targets Russian-language editing on macOS. Improvements to setup, recovery, accessibility, tests, and supported platforms are welcome.

## Run and check a change

Follow [setup](docs/setup.md). Use Node.js 24 or newer. There are no npm dependencies to install.

```sh
npm test
npm run smoke
```

On macOS with mise, prefix these commands with `mise exec --`. Unit tests use synthetic data and temporary directories. The smoke check requires FFmpeg/ffprobe with subtitle support and exercises a generated video through the local export workflow. It uses a prewritten transcript and deterministic candidate selection, so it does not test Whisper or Codex access. The printed temporary artifacts can be inspected and then removed.

When changing the player or editor, also inspect visible playback, pause, seek, and switching clips. When changing render behavior, inspect the resulting MP4 and SRT, validate dimensions, duration, and audio, and check that caption intervals remain within the clip. A successful HTTP response alone is insufficient evidence of a working video player.

Use a short generated fixture for reports and automated tests. Do not commit recordings, real transcripts, job manifests, exports, model weights, auth files, or machine-specific paths.

## Repository map

| Path | Purpose |
| --- | --- |
| `src/` | CLI, loopback HTTP server, persistence, selector, renderer, and tests |
| `src/ui/` | Browser editor, playback, shared caption and composition logic |
| `scripts/` | Whisper setup/transcription and generated-media smoke check |
| `.agents/skills/video-shorts/` | Portable editing skill, transcript adapter, and operating notes |
| `docs/` | Setup, API and data contracts, architectural decisions |
| `mise.toml`, `mise.lock` | macOS Node.js and FFmpeg versions and resolved artifacts |

Keep canonical skill files in `.agents/skills`. Agent-specific aliases, where present, should point there rather than hold independent copies. Coding agents should read [AGENTS.md](AGENTS.md).

## What to include in a pull request

Explain the user-visible problem, the resulting behavior, and what you verified. State which OS and architecture you ran on. Separate synthetic smoke checks from real recognition/selection tests. Never describe a few sampled frames as a full viewing of an export.

Preserve the [workflow contract](docs/local-workflow.md), single-writer locks, source identity checks, selected-only rendering, and invalidation of stale exports. Document intended contract changes and data migrations. Significant decisions about storage, external services, or agent behavior belong in `docs/adr`.

Use [GitHub issues](https://github.com/polomodov/shorts-studio/issues) for bugs and proposals. Include a minimal reproduction and sanitized version/error details. For vulnerabilities, follow [SECURITY.md](SECURITY.md).
