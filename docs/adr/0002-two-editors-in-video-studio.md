# 0002. Publish both editors as Video Studio

Status: accepted, 2026-11-06. Extends ADR 0001 after the user explicitly included
the existing podcast editor and approved the name `polomodov/video-studio`.

The repository contains two separate editors with their existing formats and
HTTP APIs. `src/` edits captioned vertical clips; `podcast/` edits long sequences,
camera changes and external WAV offsets. They share Node/FFmpeg discovery and
the process lock implementation. They do not share project manifests or merge
timelines automatically. A finished podcast MP4 can become a short-video source.

Podcast editing stays fully local and requires no model account. Only the shorts
candidate-selection path sends transcript text to Codex. Each workflow has its
own portable skill. Both launchers use the same macOS mise lock and retain the
existing `SHORTS_*` executable overrides. The shorts data directory keeps its
established `~/.cache/shorts-studio` name to avoid a naming change hiding data.

New podcast sidecars use `.video-studio-montage` next to user media. If only the
older `.apollo-montage` exists, reuse it. If both exist, stop and request explicit
resolution instead of guessing or merging. A process lock prevents concurrent
writers, and shutdown waits for an active render. Recordings and sidecars stay
outside Git; the repository contains only code and generated demonstration images.

The GitHub repository is renamed in place, preserving its initial history and
the old URL redirect. The original Apollo commands delegate to a user-selected
checkout through `VIDEO_STUDIO_DIR` (with `SHORTS_STUDIO_DIR` retained as an alias)
or the adjacent `video-studio` checkout. The two historical specifications remain
in Apollo as development records, not duplicated runtime contracts.

This is a bounded extraction of existing editing capabilities. A unified UI,
automatic audio synchronization, automatic timeline transfer, and localization
remain outside its scope. Revisit the split if shared editing behavior justifies
a new joint project format and a deliberate data migration.
