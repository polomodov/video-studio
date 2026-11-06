# 0001. Extract a standalone local studio

Status: accepted for the initial extraction, 2026-11-06.

## Context

The original editor lived in an editorial repository and relied on a Python
helper from a Telegram skill, a project-specific cache, and local runtime
discovery. Those assumptions prevented another person from cloning and using
the tool independently.

## Decision

Publish a source-only repository containing the editor, tests, pinned macOS
Node/FFmpeg environment, required Whisper helpers, and portable agent skill.
Keep the existing workflow and API. Do not copy the editorial repository's
history, private media, jobs, transcripts, credentials, or generated exports.
Record the source revision in THIRD_PARTY_NOTICES.md.

Use `~/.cache/shorts-studio` for new jobs and retain `--root` for explicitly
opening an existing data directory. No automatic migration or data copy occurs.
Keep Whisper's existing external cache reusable. Imported transcript metadata
must describe an import rather than claim new speech recognition.

The application remains a loopback-only, single-user editor. Video processing
and ASR are local. Candidate selection sends transcript text to Codex through
the user's existing login. Publishing media is outside the tool's scope.

Keep a single canonical skill under `.agents/skills`; `.codex/skills` and
`.claude/skills` are relative aliases. A separately installed skill discovers a
user-selected studio checkout rather than assuming a personal repository.

## Alternatives and consequences

Keeping a second maintained implementation in the editorial repository would
create version drift. Copying the entire history would mix unrelated material
with the public tool. Rewriting the editor or adopting a hosted service would
expand the task and change its data boundary.

The extraction retains a Russian interface and Russian transcript analysis.
The locked runtime covers macOS only; Linux starts with manual dependencies and
CI checks, and native Windows is not supported. Future localization, platform
support, and offline candidate selection require their own scope and checks.

The migration is tracked in [the extraction plan](../../plans/extraction.md).
