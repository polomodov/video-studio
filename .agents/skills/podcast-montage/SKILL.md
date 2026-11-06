---
name: podcast-montage
description: "Edit a full local podcast, interview, or talk in Video Studio's manual montage editor: cut or reorder ranges, change camera sources, align external WAV audio, preview junctions, save the project, and export MP4. Use for full-episode assembly; use video-shorts for transcript-assisted captioned vertical clips."
---

# Manual podcast montage

Use the existing Video Studio podcast editor for an ordered assembly of video ranges with optional external audio. It runs locally and needs Node.js, FFmpeg, and ffprobe; no transcript, Whisper, Codex login, or external model call is required. Its interface currently uses Russian.

## Locate the application and project

Read applicable `AGENTS.md`. Resolve the checkout from `VIDEO_STUDIO_DIR`, the legacy `SHORTS_STUDIO_DIR` alias, the current working repository, or the repository containing this skill when it is loaded from `.agents/skills/podcast-montage`. Verify `podcast/server.mjs`, `start-podcast.command`, and `docs/podcast-editing.md`. A separately installed skill is not the full application. If the checkout is missing, request its location or follow an explicit installation request instead of assuming a personal repository.

Read `docs/podcast-editing.md` from that checkout for the actual UI/API, storage, and timing contract. Read `docs/setup.md` only for missing runtime setup. Resolve the recording folder from the user's supplied materials; do not scan unrelated directories or infer which private episode they meant.

Check for an existing server/project before launching `./start-podcast.command /absolute/path/to/recording-folder`. The server prints its own loopback URL and scans only top-level supported regular files. The source folder must be writable. New work uses `.video-studio-montage`; a sole legacy `.apollo-montage` is reused. If both exist, preserve them and establish which saved project the user intends to continue; do not merge or delete one automatically.

Only one writer may own that project. Reuse the existing UI/API, save drafts before restarting, and finish renders before stopping. Never remove a live lock or replace project JSON behind the server.

## Establish the edit

- Preserve the existing assembly and unsaved browser form changes. Applying a clip form, saving the assembly, and rendering are different operations; exporting does not save the project.
- Follow the user's edit decisions. If only opening a workspace was requested, open it without inventing a cut list. If editing was delegated, preserve meaningful questions, qualifications, and answer context when removing pauses or repetitions.
- In/out points are times within each selected source, not positions in the output episode. The ordered list determines output order. Keep at least one output frame per clip and stay within all source durations.
- To switch cameras, select the intended source for a range and establish its source timing. The editor does not automatically synchronize cameras or detect speakers. Matching recording length is not proof of synchronization.
- For external WAV, `audioStart` is the audio position matching the video's `start`, not a relative offset. Verify a shared event at several times in long recordings. A constant offset cannot correct drift. Splitting a clip advances the right half's audio start; manual video-boundary changes require checking it again.
- Do not promise subtitles, automatic synchronization, audio mixing, or automated content selection from this editor. Captioned vertical output belongs to the separate Shorts workflow.

## Edit, save, and inspect

Use the browser or the documented local API. API writes must preserve current drafts and use the printed origin in the `Origin` header. The render endpoint consumes the submitted clips but does not save them. Avoid replacing the entire saved assembly based on stale server state while the user has unsaved edits in the browser.

Apply changes to the clip, save the project, then inspect changed junctions. `Стык →` encodes up to four seconds before and after a boundary at 960×540. Check visible frames, ordering, lip sync, audio continuity, and cut timing. Browser playback and the encoded junction are separate checks; a source that probes successfully may still have a codec the browser cannot play.

The finished episode export is 1920×1080 at 30 fps, H.264 with stereo AAC audio. Ranges are rounded to the output frame grid. Frames are fitted with padding, and a camera with no audio produces silence unless external audio was selected. Source files remain unchanged; generated MP4s use new timestamped names.

## Deliver the result

Return the actual working editor URL or saved project/output paths. Keep the server available when the user will continue editing. For an exported episode, verify dimensions, duration, clip order, and audio synchronization; watch the full output before treating it as publication-ready, or explicitly leave that review for the user. Report sampled-frame or junction checks accurately.

If the user also asks for shorts, import the rendered episode MP4 through the separate `video-shorts` workflow and explain that it may send transcript text to Codex. Podcast project edits are not shared automatically. Do not upload recordings, publish the episode, or commit media/project data unless specifically requested.
