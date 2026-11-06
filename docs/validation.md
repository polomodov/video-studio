# Initial extraction validation

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
tested. The [initial CI run](https://github.com/polomodov/shorts-studio/actions/runs/42173051612)
passed Node tests on Linux and macOS and the synthetic FFmpeg check on Linux.
A fresh public clone was started through the original repository’s compatibility
launcher with an isolated synthetic data root; checkout discovery and local-tool
fallback worked without moving existing user data.
Native Windows is unsupported. No user recording, transcript, model weight,
authentication material, or generated MP4 is included in the repository.
