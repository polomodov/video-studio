# Shorts Studio

Turn a local talk, interview, or podcast video into captioned vertical clips. Shorts Studio combines transcript-based suggestions from Codex with a browser editor and local FFmpeg rendering.

[Русская версия](README.ru.md) · [Setup](docs/setup.md) · [Agent skill](.agents/skills/video-shorts/SKILL.md) · [Contributing](CONTRIBUTING.md)

![Shorts Studio editing a synthetic test clip](docs/images/studio-synthetic.jpg)

Screenshot uses generated test media, not a real recording.

## What it does

- Reuse a timed transcript or transcribe locally with whisper.cpp.
- Ask Codex for complete, continuous ideas, then review their context before choosing clips.
- Adjust boundaries, titles, captions, and framing in a local browser UI.
- Fit the full frame, crop to portrait, stack two speakers, or combine a slide and speaker. Save reusable layout geometry.
- Export 1080×1920 H.264 MP4, burned-in captions, SRT, and an editable description. Source audio is retained when present.

This is an early local tool for transcript-driven clips, rather than a general timeline editor. Clips are continuous ranges of 5–180 seconds. The interface, selection prompt, and default speech recognition currently target **Russian-language recordings**.

## Quick start on macOS

Install [mise](https://mise.jdx.dev/installing-mise.html) 2026.11.2 or newer. The repository pins Node.js 24.22.2 and FFmpeg 8.1.2, including ffprobe and subtitle support.

```sh
git clone https://github.com/polomodov/shorts-studio.git
cd shorts-studio
mise trust
./start.command
```

Open the local URL printed in the terminal. Keep that terminal open while editing; stop with Ctrl+C. No npm package installation is needed.

The launcher installs the pinned Node.js and FFmpeg when mise is available. **Importing a new recording also needs an authenticated Codex CLI and either a timed transcript or local Whisper.** Opening the UI alone does not verify those dependencies. Follow [setup](docs/setup.md) before the first import.

Apple Silicon macOS is the validated runtime. The lockfile also contains Intel macOS artifacts, but Intel execution has not been verified. Linux with manually installed tools is experimental; native Windows is unsupported.

## Edit a recording

1. Click **Добавить видео** and enter the absolute path to a video on this computer. Import starts transcription and candidate selection.
2. Review each suggested clip, including context before and after it.
3. Edit its title, start/end times, captions, and layout. Save the changes.
4. Select the clips to export and click **Собрать выбранные**.
5. Watch each finished video, then download its MP4, SRT, and description.

If you already have a transcript, import it through the CLI **before starting the server**. This avoids unnecessary recognition. With mise on macOS, run from the clone:

```sh
mise exec -- node src/cli.mjs import \
  --source /absolute/path/recording.mp4 \
  --transcript /absolute/path/transcript.json
./start.command
```

Accepted formats and runtime overrides are documented in [setup](docs/setup.md). There is no transcript upload endpoint in the browser API yet.

## Where your data goes

Videos are read from their original paths and rendered locally. Jobs, transcripts, layout templates, and exports live in `~/.cache/shorts-studio`, or the directory supplied with `--root`. They are not part of this repository. Keep source files in place while working, and back up the data directory if you need to preserve edits.

**Codex receives the transcript text and recording title to suggest clips.** It uses your existing CLI login and account limits; no separate API key is required by Studio. The workflow is not fully offline. Installation can also download tools and model weights. Shorts Studio does not publish to social networks.

## Work with an agent

The repository includes the portable [`video-shorts` skill](.agents/skills/video-shorts/SKILL.md), its transcript normalizer, and operating notes. Use it from this checkout, or install its directory in your agent's supported skill location and set `SHORTS_STUDIO_DIR` to the absolute path of this clone. The skill does not include the application itself.

For example: “Use `$video-shorts` to prepare clips from this video and transcript, then open the editor for me to choose.”

## Development and checks

The application uses Node.js built-ins and browser JavaScript. Python helpers use the standard library. See [CONTRIBUTING.md](CONTRIBUTING.md) for checks and [AGENTS.md](AGENTS.md) for coding-agent guidance.

```sh
mise exec -- npm test
mise exec -- npm run smoke
```

The smoke check uses generated media and predetermined transcript/candidate data. It verifies a local export path, not real speech recognition, Codex selection, or editorial quality. See the [workflow contract](docs/local-workflow.md) and [data model](docs/data-model.md) before changing persistence or the API.

## License

[MIT](LICENSE). External tools and model weights have their own terms; see [third-party notices](THIRD_PARTY_NOTICES.md).
