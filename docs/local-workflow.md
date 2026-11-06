# Local workflow contract v1

This document describes the existing CLI and HTTP behavior. The server is local to one computer and one data root; it is not a hosted API. See [setup](setup.md) for dependencies and [data-model](data-model.md) for persistence.

## CLI and ownership

```sh
node src/cli.mjs serve --port 4317 --root /absolute/path/studio-data
node src/cli.mjs import --source /absolute/path/video.mp4 --transcript /absolute/path/transcript.json
node src/cli.mjs analyze JOB_ID
```

`--root` applies to all commands; omit it to use `~/.cache/shorts-studio`. `--transcript` is optional. Import without it runs local recognition if no usable transcript is already stored. Import with it attaches the transcript before preparation only when the job has no existing segments, then runs Codex selection. When segments already exist, `--transcript` is ignored, even if there are no candidates. Importing identical content in the same root reuses the existing job. `analyze` requires an existing transcript. `./start.command` starts `serve` and prints the actual local URL.

One process owns a data root. While a server is running, use its UI/API rather than starting a CLI import against the same root. For a new transcript on a job without segments, wait for pending work, save browser edits, stop the server, run CLI import, and restart. There is no HTTP transcript-upload or supported transcript-replacement API in v1. Restarting does not make `--transcript` replace existing segments.

To use a replacement transcript, preserve current drafts and decisions, then choose between continuing the current job and starting a fresh selection pass in a separate explicit `--root`. A separate root can be used while the original server remains open; its server needs a different port or `--port 0`. Existing edits are not transferred. Segment IDs are positional, so caption edits cannot safely be copied between transcripts by ID; reconcile content and timing explicitly through supported editing operations. Never edit manifests to bypass these boundaries or the process lock.

## HTTP endpoints

Requests with JSON bodies must use `Content-Type: application/json`. The maximum JSON body is 2 MiB. Long-running operations return the current job state with status 202; poll `GET /api/jobs/:id` for progress. Errors return a JSON object with `error`.

| Request | Result |
| --- | --- |
| `GET /api/jobs` | `{jobs}` |
| `POST /api/jobs` with `{sourcePath}` | Import and automatic preparation; job, 202 |
| `GET /api/jobs/:id` | Job |
| `POST /api/jobs/:id/prepare` with `{}` | Preparation or retry; job, 202 |
| `POST /api/jobs/:id/analyze` with `{}` | Analysis or retry; job, 202 |
| `POST /api/jobs/:id/analyze` with `{targetCount}` | Additional candidates, preserving existing decisions; job, 202 |
| `PATCH /api/jobs/:id/candidates/:cid` | Edited job |
| `POST /api/jobs/:id/render` with `{candidateIds}` | Render selected candidates; job, 202 |
| `GET /api/layout-templates` | `{templates}` |
| `POST /api/layout-templates` with `{name,sourceSize,layout,composition}` | `{template}`; 201 for a new snapshot, 200 for an existing identical snapshot |
| `GET` or `HEAD /media/:jobId/source` | Source video, including byte ranges |
| `GET` or `HEAD /media/:jobId/poster` | Saved poster |
| `GET` or `HEAD /media/:jobId/exports/:filename` | Only current manifest-listed export files |

Unknown routes and unsupported methods do not mutate state. Foreign Host/Origin, cross-site requests, invalid identifiers, path traversal, and out-of-range byte requests are rejected. The server binds to loopback, without a public-service authentication model.

## Candidate edits

PATCH accepts only these keys:

| Key | Allowed value |
| --- | --- |
| `selected` | Boolean |
| `start`, `end` | Finite seconds within the source; duration 5–180 seconds |
| `title` | Nonempty string, at most 200 characters |
| `layout` | `fit`, `crop`, `presentation`, `duo`, `slide-speaker` |
| `cropX` | Finite number from 0 to 1 |
| `captions` | Boolean |
| `captionEdits` | Object mapping existing segment IDs to text, at most 2000 characters each; empty text hides that segment's caption |
| `composition` | Source rectangles matching the chosen composite layout |

A rectangle is `{x,y,width,height}` in even integer source pixels. Positions are nonnegative, dimensions are at least 2, and the rectangle stays inside the source. `presentation` requires `heading`, `slide`, and `speaker`; `duo` requires `first` and `second`; `slide-speaker` requires `slide` and `speaker`. Unknown or additional region keys are rejected. In `fit`/`crop`, a stored inactive composition may remain if its keys match a supported composition.

Edits cannot modify a queued/rendering clip. Changes to rendering parameters invalidate its export; changing selection alone does not. Source transcript text stays unchanged; caption corrections are attached to segment IDs.

## Selection and rendering

Codex returns only:

```json
{"candidates":[{"startSegmentId":"s00001","endSegmentId":"s00002","title":"Working title","reason":"Why this idea stands on its own","contextRisk":""}]}
```

The program validates segment IDs and computes times. It does not accept invented free-form timestamps or quotations from the selector. Missing login, failed selection, and invalid output produce errors rather than substitute candidates. A normal request suggests roughly 6–10 clips when the source supports that many; fewer are allowed.

`targetCount` requests a total of 1–15 candidates. Additional selection requires a transcript and no ongoing render for the job. New candidates are appended with new IDs and cannot overlap existing candidates or each other. A weaker source may yield fewer than requested; reaching the target is a no-op. A request without `targetCount` retains the ordinary idempotent behavior when candidates already exist.

Rendering requires an explicit list of unique IDs, each with `selected=true`, and allows at most 15. Server-side validation enforces this independently of the UI. Each clip is a continuous range rendered to 1080×1920 H.264 MP4, with AAC if the source has audio. Phrase captions use ASS for burned-in text and SRT for the sidecar. Review edits and the completed video before publishing.

Downloads use the candidate title as a sanitized UTF-8 filename through `Content-Disposition: inline; filename; filename*`. Internal filenames retain their revision suffixes. HEAD and Range responses preserve the disposition; playback is not forced into a download. Only current manifest-listed files are served, even if older rendered files still exist on disk.

## Layouts and previews

| Layout | Output composition |
| --- | --- |
| `fit` | Full frame contained within portrait output |
| `crop` | Portrait fill, with horizontal position controlled by `cropX` |
| `duo` | First participant y0–840, captions y840–1080, second participant y1080–1920 |
| `slide-speaker` | Slide y0–810, captions y810–1050, speaker y1050–1920 |
| `presentation` | Legacy heading y0–180, slide y180–720, captions y720–960, speaker y960–1920 |

Slides and legacy heading regions fit without cropping. Speaker regions cover their output blocks with centered cropping. All regions come from the same moving source frame. The preview shares the renderer's region plan and phrase timing; Canvas and libass may rasterize text differently. Region detection is manual.

The visual editor supports drawing a selected region, dragging it, resizing at a corner, and arrow-key movement; Shift increases the movement step. Escape or pointer cancellation cancels the current gesture. Numeric fields support editing without a mouse. A gesture changes only the browser draft; it does not automatically PATCH, select, or render a candidate.

## Layout templates

A template request contains exactly `name`, `sourceSize`, `layout`, and `composition`. The name is NFC-normalized and trimmed, 1–120 characters, with no control characters. `sourceSize` contains integer width and height from 1 to 32768. Only `presentation`, `duo`, and `slide-speaker` can be saved as templates, with the corresponding validated rectangles.

The server returns `version:1,id,name,sourceSize,layout,composition,createdAt`. It assigns the ID and timestamp; callers cannot supply those fields. The ID is the first 16 hex characters of a SHA-256 over normalized input. Saving an identical snapshot is idempotent. There is no update/delete endpoint.

Saving a template captures the effective browser draft geometry and does not save the candidate. Applying it changes only the draft's layout/composition, preserving title, boundaries, captions, and selection. If `abs((targetWidth/targetHeight)/(sourceWidth/sourceHeight)-1) <= 0.01`, regions scale by axis to even source pixels within the target frame; otherwise application fails without changing the draft. Matching resolution or aspect ratio does not establish matching speaker/slide placement. Check the result across the selected interval before saving it.
