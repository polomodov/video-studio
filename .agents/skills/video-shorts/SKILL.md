---
name: video-shorts
description: "Prepare and edit captioned vertical clips from local talks, interviews, or podcasts using Video Studio. Use for transcript-based candidate selection, framing, caption correction, and MP4/SRT export; not for a text-only summary of a video."
---

# Video clips with Video Studio

Use the existing Studio workflow: timed transcript → suggested candidates → user selection/editing → local FFmpeg export. Video stays local; Codex receives the transcript text and recording title using its existing CLI login. The UI and default recognition/selection currently target Russian recordings.

## Locate Studio

Read applicable `AGENTS.md`. Resolve the application checkout in this order:

1. `VIDEO_STUDIO_DIR`, or the legacy `SHORTS_STUDIO_DIR` alias, when supplied, must be the absolute path to the checkout. Prefer `VIDEO_STUDIO_DIR` if both are set.
2. The current working repository, if it contains `src/cli.mjs` and the Video Studio package.
3. The repository containing this skill, when loaded from its canonical `.agents/skills/video-shorts` directory.

Verify `src/cli.mjs`, `start.command`, and `docs/setup.md` exist in that checkout. This skill can be installed separately; its own directory is not always the application. If the checkout is unavailable, request its location or follow the user's instruction to install it. Do not assume a sibling repository, scan unrelated personal directories, or invent a missing tool.

Read `docs/setup.md` from the resolved checkout for actual commands and prerequisites. Read `docs/local-workflow.md` when using the API or modifying layouts. These application documents remain the command/schema authority; paths below are relative to the resolved checkout unless explicitly skill-relative.

For a running server, external transcript import, or black video playback, read the relevant part of [operations](references/operations.md). Reuse the user's existing job and saved edits where available.

## Reuse a transcript

First look for a suitable transcript in the material the user provided or the project sources they authorized. A web summary is not a timed transcript. For a Git source, follow its access rules and record a pinned commit/path; do not modify the source repository as part of reading it.

Match the episode, participants, and media version. A separately edited audio podcast may have different timing from the MP4. Check speech alignment at several points and establish any offset before selecting clips. Keep the transcript's provenance, media version, and offset alongside working data outside Git. Do not describe an imported transcript as new recognition.

Studio accepts seconds in `segments[].start/end` and milliseconds in whisper.cpp `transcription[].offsets.from/to`. For `segments[].start_ms/end_ms`, use the skill-local [JSON adapter](scripts/normalize_transcript.py). It writes a separate file, refuses to overwrite output, and does not infer offsets or parse SRT. Import using the supported CLI `--transcript` option. Only run recognition when a suitable transcript is unavailable. Check names, numbers, and technical terms against the recording.

## Prepare candidates and edits

- The normal selector suggests roughly 6–10 continuous complete ideas, usually 30–90 seconds, when the material supports them. Respect the user's requested quantity and purpose; Studio permits 5–180 seconds per clip and at most 15 candidates.
- Check beginnings, endings, and surrounding context. Preserve meaningful questions, negatives, conditions, and qualifications. Titles should describe what the clip actually contains.
- For slides or multiple speakers, inspect existing layout templates. Matching resolution does not establish matching placement. Check regions near the start, middle, end, and scene changes; keep captions clear of faces and diagrams. Use the full-frame layout when a stable composite cannot preserve context.
- Save caption corrections and geometry through the editor or supported PATCH API. Do not strengthen a claim by rewriting the speaker's words or invent an inaudible term.
- Normally present candidates for the user's selection in the UI. If the user already selected clips or explicitly delegated selection and export, carry it out without asking again. Preserve server-side `selected` checks; do not bypass them by writing manifests.
- A technical fixture or preview belongs in an isolated data root and is not a selected clip from the user's recording. Do not substitute hand-written candidates for a failed Codex selection without explaining the failure and obtaining an instruction for that different workflow.

## Verify and deliver

Open the intended job. Check visible video during playback, pause, seeking, and clip switching. Advancing time, `readyState`, and HTTP 206 do not prove that frames are visible. Inspect the rendered output too when exporting. State the scope of viewing accurately; sampled frames are not a full playback review.

For exports, verify 1080×1920 dimensions, requested duration, audio when the source has it, and readable captions within the clip's interval. Watch the finished clip in full before treating it as ready to publish, or clearly identify that review as remaining work for the user.

Return the running Studio URL and actual candidate count, or the resulting MP4/SRT/description paths. Leave the server available when the user is continuing to edit. Capture a screenshot of visible playback when performing UI verification. Creating clips does not authorize social publishing, uploading source media, or committing private transcripts and exports.
