# External tools and provenance

Video Studio was extracted from the author-maintained tools in
[polomodov/apollo-robotics at f7347879](https://github.com/polomodov/apollo-robotics/tree/f7347879fdd320471f45ff1e6e8383501f277552/scripts/shorts).
The video-shorts skill, transcript adapter, and Whisper setup/transcription
helpers were adapted from the same revision. The new repository starts with a
source-only snapshot; it does not contain the source repository's Git history,
editorial content, user recordings, transcripts, or credentials.

The application has no npm runtime dependencies. The following tools are
installed separately and retain their own licenses and terms:

- [Node.js](https://github.com/nodejs/node/blob/main/LICENSE).
- [mise](https://github.com/jdx/mise/blob/main/LICENSE).
- [FFmpeg](https://ffmpeg.org/legal.html). The conda-forge build pinned in
  `mise.lock` is a GPL build with libx264 and libass. No FFmpeg binary is bundled
  in this repository. Its dependency packages have their own licenses.
- [whisper.cpp](https://github.com/ggml-org/whisper.cpp/blob/v1.9.1/LICENSE),
  built from a pinned upstream revision by `scripts/setup_whisper.sh`.
- [Whisper model weights](https://github.com/openai/whisper#license), downloaded
  separately from the upstream ggml model mirror and checked by SHA-256.
- [Codex CLI](https://github.com/openai/codex/blob/main/LICENSE). Account access,
  service terms, availability, and usage limits are separate from this project.

The project license applies to its own code and documentation, not to external
executables, models, system fonts, or user media. No fonts or model weights are
included. Captions use an available system font through libass.

The podcast editor was extracted from [apollo-robotics at e487493b](https://github.com/polomodov/apollo-robotics/tree/e487493b3382943e10185ba015042daebe5860c2/scripts/podcast-montage), again as source only. Episode media, sidecar projects and editorial materials were not included.
