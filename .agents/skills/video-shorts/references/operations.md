# Studio operations

Resolve the application checkout as described in `SKILL.md`. Commands here run from that checkout, not from a separately installed skill directory. The application's `docs/setup.md` and `docs/local-workflow.md` are authoritative for setup and API fields.

## Runtime and an existing server

- Default data root: `~/.cache/shorts-studio`; jobs: `jobs/<id>/job.json`; reusable geometry: `layout-templates.json`. `--root` overrides the data directory. Do not confuse checkout location (`SHORTS_STUDIO_DIR`, used by this skill) with job storage (`--root`, used by the application).
- `./start.command` starts the server, normally on `http://127.0.0.1:4317/`. Use the URL actually printed. With a macOS mise install, trust the reviewed checkout config before first launch. The launcher locates mise; it does not activate the caller's shell.
- For CLI commands use `mise exec -- node src/cli.mjs ...` on macOS with mise, or `node src/cli.mjs ...` with local tools. `--help` lists supported operations.
- One writer owns each root. If a server is running, use its API/UI. Do not delete its lock or launch a concurrent CLI import. Before restarting, wait for queued work and save unsaved browser edits. Do not interrupt unrelated Studio instances.
- `SHORTS_FFMPEG`, `SHORTS_FFPROBE`, `SHORTS_PYTHON`, and `SHORTS_CODEX` select explicit executables. Check overrides, the optional `~/.cache/shorts-studio/bin`, and `PATH` before reinstalling tools. FFmpeg must have the `subtitles` filter for burned-in captions; `-version` alone is insufficient.
- Codex uses its own login. Do not inspect or copy auth files. A login or selection failure is not permission to replace the workflow with an API key or invented JSON.

## Import an existing transcript

For a new job, or an existing job with no transcript segments, stop the server for that root before importing:

```sh
mise exec -- node src/cli.mjs import \
  --source /absolute/path/video.mp4 \
  --transcript /absolute/path/studio-transcript.json
./start.command
```

For a custom data root, pass the same `--root` to both commands. Omit `mise exec --` only when using manually configured local tools.

`--transcript` is ignored whenever the existing job already has segments, even if it has no candidates. Re-importing identical video content in the same root reuses that job. Stopping and restarting the server does not make import replace its transcript. There is no supported transcript-replacement API.

If the user brings a replacement transcript, first preserve unsaved browser drafts and existing decisions. Explain the choice: continue editing the current job, or start a separate selection pass using the new transcript in a new explicit `--root`. The original server can stay open when the new pass uses a different root. Start a new server with that same new root and a different port (or `--port 0`) to compare results. This preserves the original job but does not transfer its edits. Do not copy `captionEdits` by segment ID between transcripts: IDs are positional and may identify different speech. Reconcile any chosen edits by actual content and timing through supported editing operations.

`POST /api/jobs` automatically starts preparation and can trigger recognition before an external transcript is attached. There is no HTTP upload-transcript endpoint. When importing into a root whose existing job has no segments, complete its queue, save drafts, stop its owner normally, use CLI import, then restart. Do not invent an endpoint or write manifests around Store/lock validation.

The adapter is **relative to this skill's own directory**:

```sh
python3 /absolute/path/to/video-shorts/scripts/normalize_transcript.py \
  /absolute/path/original.json /absolute/path/studio-transcript.json
```

It accepts `segments[].start/end` in seconds, `segments[].start_ms/end_ms`, or `transcription[].offsets.from/to` in milliseconds. It preserves text and timing, refuses to overwrite output, and does not parse SRT or infer synchronization offsets. Keep output outside Git. If a source comes from a repository, read a pinned blob and record commit/path separately.

## Layouts and exports

Templates contain source dimensions and region geometry: `first/second` for two speakers, `slide/speaker` for slides with a speaker, or legacy `heading/slide/speaker`. Applying a template changes the browser draft, not the saved selection and not the render queue. Check actual placement over the clip before saving. The application contract defines aspect-ratio tolerance, even coordinates, and bounds.

Title, caption, boundary, or composition edits require a new render. A previously generated MP4 is not evidence of those latest changes. Download or play only the current manifest-listed export and report any remaining review.

## Diagnose black playback

1. Record the job, clip, playback time, and unsaved edits. With browser tools, inspect the source URL, media errors, ready state, dimensions, pause state, and a screenshot of the visible frame.
2. If loading/decoding fails, check the source, HTTP Range response, and codec before proposing a full transcode.
3. If video time advances but the image is black, inspect the canvas display in `src/ui/player.mjs`, canvas dimensions, and frame updates on `loadeddata`, `seeked`, play, and pause. A CSS change without replaying the failure is not a verified fix.
4. Check play, pause, seek, switching clips, and visibility at the affected window size. Save a screenshot. Check the finished-export player separately when it changed.

If browser tools are unavailable, report that visual playback was not verified. Server tests and HTTP responses cannot establish visible playback by themselves.
