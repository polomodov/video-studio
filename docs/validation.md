# Extraction validation

Checked on 2026-11-06 on macOS Apple Silicon. These results describe the initial
source extraction, not a benchmark or a claim of editorial quality.

## Automated and media checks

- 58 Node unit/HTTP tests passed, including single-writer locking, Host/Origin
  boundaries, selection-before-render, stale exports, composition, captions,
  launcher path handling, and imported-transcript provenance.
- Bash syntax and Python helper entry points passed with Python 3.9.6.
- The skill validator and UI metadata checks passed. The transcript normalizer
  converted millisecond timings, preserved its input, and refused to overwrite
  an existing output.
- `npm run smoke` generated an eight-second test pattern with audio, attached
  two prewritten Russian captions, and used a deterministic candidate selector.
  Real HTTP edits selected a six-second range, then real FFmpeg rendering,
  HTTP downloads, ffprobe, and full decode succeeded. Output was 1080×1920
  H.264/AAC, 6.000 seconds, with non-silent audio and subtitle intervals 0–3 and
  3–6 seconds. Both caption frames were visually inspected.
- The standalone launcher was started from outside the checkout through mise
  with the pinned Node.js 24.22.2 / FFmpeg 8.1.2 environment and an isolated job
  directory. Browser checks showed visible source playback, seeking, switching
  to the export, and the six-second export reaching its end. The screenshot in
  the README contains only synthetic fixture content.

## Actual ASR and model selection

A separate 28.198-second video combined a generated test pattern with Russian
speech synthesized by macOS Milena. The ordinary CLI `import` ran **without**
`--transcript` and without an injected selector.

- Existing whisper.cpp v1.9.1, large-v3, Metal produced five timed segments.
- Existing Codex CLI 0.166.0-alpha.5.1, authenticated through ChatGPT, returned one
  candidate spanning 0–28.06 seconds.
- The job finished `ready`, with no error. The candidate remained unselected.
- No new model download was performed for this check.

This verifies the bundled helper path and actual ASR→Codex integration on
synthesized speech. It is not a test of a long talk, noisy audio, or an author's
finished episode. The tested Codex version is a bundled build; other CLI
versions must support the isolation flags in `src/codex.mjs`.

## Platform and coverage limits

The macOS lock includes Intel artifacts, but Intel execution has not been
tested. The [initial CI run](https://github.com/polomodov/video-studio/actions/runs/42173051612)
passed Node tests on Linux and macOS and the synthetic FFmpeg check on Linux.
A fresh public clone was started through the original repository’s compatibility
launcher with an isolated synthetic data root; checkout discovery and local-tool
fallback worked without moving existing user data.
Native Windows is unsupported. No user recording, transcript, model weight,
authentication material, or generated MP4 is included in the repository.

## Podcast editor and broader project name

The user included the existing long-form podcast editor and approved Video Studio.
The GitHub repository was renamed in place. The combined Node suite has 68 passing
tests (58 for shorts and 10 for podcast editing/launch), including new sidecar
compatibility and process-lock checks. Both portable agent skills validate.

A real podcast smoke test generated two camera files at 25/60 fps and external WAV
files at 440/880 Hz. HTTP save/reopen preserved two clips and their audio offsets.
Invalid WAV ranges, foreign origins, invalid byte ranges and concurrent renders
were rejected. No user recording or sidecar was involved.

- Junction preview: 8.000 seconds, 960×540, 30 fps, H.264/AAC.
- Full edit: 10.066667 seconds, 1920×1080, 30 fps, H.264/AAC.
- Both exports fully decoded. Decoded audio samples switched from 440 to 880 Hz
  across the cut with nonzero signal energy.
- Browser checks showed source playback and rendered junction playback reaching
  its end. The podcast screenshot contains only these synthetic sources.
- The Apollo podcast compatibility command passed nine isolated groups of checks;
  the shorts launcher passed eight before the naming alias extension.

Podcast rendering was validated with the pinned FFmpeg 8.1.2 on Apple Silicon.
Its `scale:reset_sar` requirement is checked with that runtime in macOS CI; the
Ubuntu system-FFmpeg check remains the shorts smoke test. This does not claim a
full Linux Whisper/Codex pipeline or a production-length podcast export.

The [combined-editor CI run](https://github.com/polomodov/video-studio/actions/runs/42179910437)
passed on both Linux and macOS, including the podcast smoke under the pinned
mise runtime on macOS. Both original Apollo entry points also launched the
published checkout under its new name with isolated synthetic projects.
