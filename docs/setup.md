# Setup and operation

Run commands from the Shorts Studio clone unless stated otherwise. The UI and default analysis workflow currently use Russian. [README](../README.md) gives the short introduction.

## Requirements

| Component | When needed | Notes |
| --- | --- | --- |
| Node.js 24 or newer | Always | Pinned to 24.22.2 with mise. |
| FFmpeg with `libx264`, AAC, and `subtitles`/libass | Import and rendering | Pinned to 8.1.2 with mise on macOS. A plain `ffmpeg -version` check does not establish subtitle support. |
| ffprobe | Recommended | Included with the pinned FFmpeg. Studio has an FFmpeg probing fallback. |
| Authenticated Codex CLI | Candidate selection | Uses its own login. Account access and usage limits apply. |
| Python 3.9 or newer | Local speech recognition and transcript adapter | Standard library only; not required to import already supported transcript JSON. |
| whisper.cpp and a model | Recognition when no transcript is available | The included setup helper builds v1.9.1 and downloads multilingual large-v3. |
| Git, CMake, C++ compiler, curl or wget | Building Whisper | Needed only for its setup helper. On macOS, a compiler is available through Xcode Command Line Tools. |

No runtime npm dependencies are required. Tool installation needs network access. Recognition and rendering run locally; Codex selection sends transcript text and the recording title to Codex.

## macOS with mise

Install [mise](https://mise.jdx.dev/installing-mise.html) 2026.11.2 or newer, clone the project, and inspect `mise.toml` before trusting it:

```sh
git clone https://github.com/polomodov/shorts-studio.git
cd shorts-studio
mise trust
mise install
./start.command
```

The launcher finds mise in `PATH`, `~/.local/bin`, `/opt/homebrew/bin`, or `/usr/local/bin`. Shell activation is not required. It resolves the managed Node.js, FFmpeg, and ffprobe before adding the optional local tools directory to `PATH`; explicit `SHORTS_FFMPEG` and `SHORTS_FFPROBE` overrides take precedence. Subsequent launches reuse installed tools. `mise install` can also run ahead of time so the first launch does not need downloads.

`mise.lock` covers `macos-arm64` and `macos-x64`. Apple Silicon is the validated execution platform; the Intel entries do not constitute an Intel test. Allow space for Node.js, the FFmpeg dependency bundle, models, source media, and render output.

For CLI commands, use `mise exec --` explicitly, or activate mise in your own shell. The launcher's environment does not modify the terminal that invoked it:

```sh
mise exec -- node src/cli.mjs --help
mise exec -- ffmpeg -filters
```

Check that the filters include `subtitles`.

## Codex login

Install the [Codex CLI](https://github.com/openai/codex) and sign in using its documented login flow. Confirm the local command is available:

```sh
codex --version
codex login status
```

Studio looks in `PATH` and known macOS Codex application locations, or uses the executable specified in `SHORTS_CODEX`. It does not read or copy authentication files. The selector removes API-key environment overrides and uses the CLI's own authentication.

The extraction was checked with Codex CLI `0.166.0-alpha.5.1`; this records the tested build, not a claim about the latest stable release.

If selection fails, first check login status and account limits. Older CLI builds may not recognize the isolation flags used in `src/codex.mjs`; update a compatible CLI rather than disabling the isolation settings. The tool never treats fabricated candidates as a successful Codex result.

## Use an existing transcript

This path skips Whisper and its model download. The CLI accepts either:

```json
{"segments":[{"start":0,"end":6,"text":"Example spoken text."}]}
```

Here `start` and `end` are seconds. It also accepts whisper.cpp JSON with `transcription[].offsets.from/to` in milliseconds. Use the entire timed transcript corresponding to the media version, not a summary.

If your JSON uses `segments[].start_ms/end_ms`, normalize it first:

```sh
python3 .agents/skills/video-shorts/scripts/normalize_transcript.py \
  /absolute/path/original.json /absolute/path/studio-transcript.json
```

The adapter writes a new file and refuses to overwrite it. It accepts JSON only, not SRT or plain text. It does not calculate time offsets between different versions of a recording. Check synchronization against the actual video, especially if an intro was trimmed or the transcript came from a separately edited podcast.

For a new job, or a job with no existing transcript segments, save any browser drafts and stop the server for its data directory before importing:

```sh
mise exec -- node src/cli.mjs import \
  --source /absolute/path/recording.mp4 \
  --transcript /absolute/path/studio-transcript.json
./start.command
```

Import attaches the supplied transcript only if the job has no existing segments, then starts preparation and selection. **If segments already exist, `--transcript` is ignored, even when there are no candidates.** Re-importing the same video content in the same data root reuses its existing job and saved decisions. Restarting the server does not change this behavior. There is no supported transcript-replacement API.

To try a replacement transcript, first save current browser drafts. You can continue the original job, or keep it intact and create a separate selection pass in a new explicit data root:

```sh
mise exec -- node src/cli.mjs import \
  --root /absolute/path/new-transcript-pass \
  --source /absolute/path/recording.mp4 \
  --transcript /absolute/path/replacement-transcript.json
./start.command --root /absolute/path/new-transcript-pass --port 0
```

The original server can stay open because the new pass uses a different root and port. The new pass does not inherit the original edits. Do not copy caption corrections by segment ID between transcripts: IDs are positional and may refer to different speech. Compare the actual content and timing before reapplying any edits through the editor.

The browser's `POST /api/jobs` starts preparation automatically and cannot attach an external transcript in the same request.

## Install local Whisper

Skip this section when you have a suitable transcript. The helper downloads about **3 GB** of model weights and compiles whisper.cpp, so the first setup takes time and additional disk space. Review the helper before running it. It verifies the pinned source revision and model checksum.

On macOS, install Git, CMake, a C++ compiler, and curl or wget through your usual package manager or developer tools. With mise available:

```sh
mise exec -- bash scripts/setup_whisper.sh --backend auto
```

The helper chooses Metal on macOS and builds a CPU fallback. Files default to `~/.cache/whisper.cpp`; they are separate from Studio's job data. `--backend cpu` requests a CPU build. Linux also supports optional Vulkan/HIP backends, which require their own toolchains; Linux execution is experimental for Studio.

You can reuse an existing compatible binary and model:

```sh
export WHISPER_CPP_BIN=/absolute/path/whisper-cli
export WHISPER_MODEL_PATH=/absolute/path/ggml-large-v3.bin
./start.command
```

`WHISPER_CPP_HOME` changes the wrapper's cache lookup root. If unset, the Whisper helper honors `XDG_CACHE_HOME` before using `~/.cache/whisper.cpp`. The Studio job directory itself uses `--root`, not `XDG_CACHE_HOME`.

The standalone helper offers more options via `python3 scripts/transcribe_media.py --help`. Studio invokes it with Russian recognition and zero retained text context. Choosing a different language in the helper does not change Studio's default language or selection prompt.

## Without mise and on Linux

Install Node.js 24+, FFmpeg with libass/libx264/AAC, and the optional components above yourself. `./start.command` can use local tools. On Linux the launcher skips the macOS-only mise bundle and uses the local environment. To run CLI commands without mise:

```sh
node src/cli.mjs serve
node src/cli.mjs import --source /absolute/path/recording.mp4
```

Do not run those two commands against the same data directory at the same time. Native Windows is unsupported because the launcher and transcription helper depend on Unix facilities. WSL has not been verified.

If a tool is installed outside `PATH`, set its absolute executable path:

| Variable | Purpose |
| --- | --- |
| `SHORTS_FFMPEG` | FFmpeg executable |
| `SHORTS_FFPROBE` | ffprobe executable |
| `SHORTS_PYTHON` | Python executable for recognition |
| `SHORTS_CODEX` | Codex executable for selection |

The optional `~/.cache/shorts-studio/bin` directory is also searched for local media tools. An explicit override is authoritative: if it is invalid, Studio reports an error rather than silently choosing a different executable.

## Data directories and existing jobs

The default is `~/.cache/shorts-studio`. Keep it outside a Git repository. Specify another directory on every related command:

```sh
./start.command --root /absolute/path/studio-data --port 4317
```

`--port 0` chooses an available port; always use the printed URL. Relative `--root` paths are resolved from the caller's working directory, including through the launcher. A single writer lock prevents a server and a CLI import from editing the same root simultaneously. Stop the owner normally; do not delete a live lock.

The directory contains job manifests, original transcript JSON, derived transcripts, posters, exports, and reusable layout templates. Source video is referenced by path and content identity. Source replacement or modification requires re-import. Back up this directory if its edits matter; its name contains “cache” but it stores author decisions.

If moving from the original embedded Studio, stop its server and point the standalone launcher at the existing data directory with `--root`. The default directory changed; no data is silently copied or migrated. Verify a saved job and export before switching your normal launcher.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| mise reports an untrusted config | Inspect this clone's config, then run `mise trust` from it. |
| UI opens but import fails | Check Codex login and either a supplied transcript or the Whisper binary/model. UI startup only needs Node.js. |
| Export fails around `subtitles` | Confirm the selected FFmpeg has the `subtitles` filter and a usable font. Explicit overrides can select a different build from mise. |
| Server says the directory is busy | Find and stop the existing writer normally, or use a different root. |
| Player time advances but video is black | Check actual visible frames, media errors, seeking, and another clip. The canvas player is in `src/ui/player.mjs`; HTTP 206 alone does not prove visible playback. |
| Saved export disappears after editing | The previous render is stale. Build again with the new edit; old files remain locally but are no longer served as current results. |
| Recognition repeatedly fails | Read the error, verify the media/model/binary, and retry after fixing it. Invalid transcript output is quarantined instead of silently reused. |

For a reproducible generated-media check, run `mise exec -- npm run smoke` on macOS or `npm run smoke` with local tools. It retains temporary artifacts for inspection and does not call Whisper or Codex.
