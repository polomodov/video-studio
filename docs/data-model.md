# Local data model

Data lives under `~/.cache/shorts-studio` by default, or the CLI `--root`. It includes author decisions despite the directory being named “cache”; preserve it when those edits matter. Media, transcripts, jobs, and exports stay outside Git.

## Job

Each `jobs/<id>/job.json` contains a v1 job with:

- `id`: first 16 hex characters of the source content SHA-256.
- `title` and `source`: path, name, SHA-256, bytes, modification time, duration, width, height, frame rate, and whether audio is present.
- `status`, `progress`, `error`, and creation/update timestamps.
- `segments`, `candidates`, `transcription`, and `analysis`.

Manifests are written atomically. A PID/token lock permits one writer per root. Heavy operations are queued serially; a second operation on an already busy job is rejected. Source modification requires re-import. Importing identical content preserves decisions and updates the reference to its current path.

A `Segment` has `id,start,end,text`, with finite times in seconds and `0 <= start < end <= duration`. Normalization accepts source transcript ends up to two seconds beyond the source duration, clamping only the end; starts must lie inside the recording. Silence markers and empty text are excluded.

Transcription metadata links the transcript to the source SHA-256. Imported transcripts use `engine: "imported"`; local recognition uses `engine: "whisper.cpp"`. This field does not establish the original engine or authorship of an imported file. Preserve external source/version/offset provenance separately when reusing a transcript.

## Candidate and export

A `Candidate` stores `id`, start/end segment IDs, computed `start/end`, `title`, `reason`, `caution`, `hook`, and editing/render state. Codex's `contextRisk` becomes `caution`. Defaults are `selected:false`, `layout:"fit"`, `cropX:0.5`, `captions:true`, and an empty `captionEdits` map. Duration is 5–180 seconds. Caption corrections reference existing segment IDs without rewriting the original transcript.

`layout` is `fit`, `crop`, `presentation`, `duo`, or `slide-speaker`. Composite modes require their corresponding `composition` rectangles. Each rectangle has only `x,y,width,height`, all even integers within the source, with dimensions at least 2. Inactive valid geometry may remain when switching to fit/crop. Episode-specific geometry belongs in local manifests or templates, not application source code.

`Candidate.export` contains filenames for MP4/SRT/TXT, a render revision, creation time, and URLs. The revision depends on source identity and render parameters. Editing those parameters clears the current export and makes a previous ready render stale. Old files can remain on disk, but the HTTP server does not serve them as current exports. Selection changes alone do not invalidate a render.

An export filename is an internal identifier. Download names instead use the candidate title, sanitized for a filesystem and constrained by UTF-8 byte length. See the [workflow contract](local-workflow.md).

The repository's synthetic smoke check uses a separate temporary data root. Its seeded candidates and exports must not be confused with real editorial choices.

## Layout templates

`layout-templates.json` stores `{version:1,templates:[]}` for the data root, shared by jobs. Each template is an immutable snapshot with:

```text
version: 1
id: 16 hexadecimal SHA-256 characters
name: normalized, trimmed string of 1–120 characters
sourceSize: {width, height}
layout: presentation | duo | slide-speaker
composition: the regions required by that layout
createdAt: canonical ISO timestamp
```

Template IDs hash normalized name, source size, layout, and geometry. An identical input returns the existing snapshot. IDs and timestamps are assigned by the server. Source dimensions are integers from 1 to 32768; geometry uses candidate validation. Templates contain no job/candidate references, source paths, transcript text, clip boundaries, selection, or caption corrections. Unknown fields are rejected.

Writes are atomic and serialized under the server's process lock. Corrupt data produces an error instead of being replaced with an empty catalog. There is no template update/delete API.

Applying a template copies layout/composition into the browser draft without retaining a live reference. When aspect ratios differ by no more than 1%, regions scale by axis, round to even coordinates, and stay within the target source with dimensions at least 2×2. Otherwise the draft stays unchanged. The candidate changes only after a normal save; later catalog changes do not affect it.

## State transitions

```text
Job: imported -> transcribing -> analyzing -> ready
Failure: error, or ready with error when previous candidates are retained
Render: idle -> queued -> rendering -> ready | error
Edit of a previous rendered result: stale
```

Import with a transcript skips transcription. Retries reuse valid existing work. Interrupted operations are marked as errors during recovery after restart. Additional selection appends up to 15 total candidates without changing existing objects or the manifest schema; selector options for count and excluded intervals are transient.
