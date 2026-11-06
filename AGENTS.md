# Shorts Studio contributor guidance

Shorts Studio is a local video clipping and caption editor. Work on the reusable application here; keep user recordings and editorial material outside the repository.

- Keep application code in `src/`, runtime helpers in `scripts/`, documentation in `docs/`, and canonical agent skills in `.agents/skills/`.
- Use Node.js 24 or newer and the built-in test runner. No runtime npm dependencies are required.
- Never commit source media, user transcripts, jobs, generated exports, model weights, caches, credentials, or authentication files. Test media must be generated outside the repository.
- Preserve loopback-only HTTP serving, origin/host checks, single-writer locks, selected-only rendering, and stale-export invalidation.
- User files stay local. Codex receives transcript text using its own authentication; do not read or copy its auth files.
- Prefer existing jobs and transcripts. Do not edit job manifests around supported APIs or locks.
- Use synthetic fixtures for reproducible checks and distinguish them from actual speech recognition and candidate selection.
- Document setup and limitations honestly. The UI currently uses Russian; do not imply localization or platform validation that has not occurred.
- Make architecture and data-boundary decisions explicit in docs/adr.

## Commands and ownership

- `npm test` runs the Node unit and HTTP tests. `npm run smoke` generates a temporary synthetic video and checks real FFmpeg export; it needs FFmpeg/ffprobe and libass, but no account or model. On macOS, prefix these commands with `mise exec --`.
- `./start.command` starts the editor. Read `docs/setup.md` before changing tool discovery or installation.
- Read `docs/local-workflow.md` and `docs/data-model.md` before changing APIs, job persistence, caption timing, or composition geometry. Preserve existing saved jobs unless an explicit migration is planned.
- Canonical skills live in `.agents/skills/`; `.codex/skills` and `.claude/skills` are aliases. Edit only the canonical copy.
- Keep English `README.md` and `README.ru.md` meaningfully aligned. New UI localization is a separate change; do not silently mix interface languages.
- Run checks relevant to a change and report actual scope. UI changes need visible browser verification, including playback when relevant. Never equate sampled frames with watching an entire recording.
- Do not auto-update installed tools, download large models, upload media, or invoke account-backed selection merely to run unit tests.
