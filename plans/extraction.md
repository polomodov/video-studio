# Video Studio extraction

## Purpose and proportionality

Make the existing local editor reusable outside its author's editorial
repository. This is a bounded infrastructure migration preserving the existing
editing contract, so one tracker is proportionate instead of a new feature
specification. The lasting data and source boundary is recorded in
[ADR 0001](../docs/adr/0001-standalone-local-studio.md).

## Scope

- Extract source, UI, tests, launcher, pinned runtimes, Whisper helpers, and skill.
- Remove personal checkout/runtime assumptions and separate generated data.
- Provide English/Russian onboarding, contributor and agent guidance, licensing,
  dependency notices, and CI.
- Verify source-only publication, fresh-clone startup and captioned export.
- Leave a migration path in the original repository without moving user data.

Out of scope: new editing features, full localization, hosting, automatic social
publishing, native Windows support, moving recordings, or promising production
readiness from a synthetic test.

## Decisions, open questions and dependencies

- Confirmed public repository: `polomodov/video-studio` (renamed from shorts-studio).
- Confirmed license: MIT for original code; external tools retain their licenses.
- Existing Node 24.22.2 / FFmpeg 8.1.2 macOS lock is retained.
- New data defaults to `~/.cache/shorts-studio`; old data can be opened with `--root`.
- Source snapshot: `apollo-robotics@f7347879fdd320471f45ff1e6e8383501f277552`.
- Open: broader Codex-version compatibility, localization, Linux runtime lock.
- Dependencies: Node, FFmpeg/libass/libx264, optional Python/Whisper for ASR,
  authenticated Codex CLI for candidate selection, GitHub publication access.

## Acceptance and step status

| Step | Acceptance | Status |
| --- | --- | --- |
| Inventory | Every runtime dependency is included or explicitly installed | Complete |
| Extraction | No runtime link to the editorial repository or private runtime | Complete |
| Docs and skill | A new user can follow setup and find the editing workflow | Complete |
| Verification | Unit/HTTP tests and real captioned FFmpeg export pass | Complete |
| Publication | Public source-only repository, license, CI and clone verified | Complete |
| Original-repo migration | Launcher/skill route to the standalone checkout | Implemented and tested; PR #389 open |

## Validation

Planned: Node tests, Python helper entry points and adapter behavior, shell
syntax, isolated launcher startup, real synthetic HTTP render/download/full
decode with caption-frame inspection, repository content/link review, and CI.
Record actual results in [validation.md](../docs/validation.md), distinguishing
synthetic fixtures from real ASR and model selection.

## Change links

- [Public repository](https://github.com/polomodov/video-studio)
- [Source mise PR](https://github.com/polomodov/apollo-robotics/pull/387)
- [Original-repository migration PR #389](https://github.com/polomodov/apollo-robotics/pull/389) (open, not merged).
- [Initial commit](https://github.com/polomodov/video-studio/commit/7193c9d30b3ca0c38a4b22128a68bf9cf51d4cea).
- [CI verification](https://github.com/polomodov/video-studio/actions/runs/42173051612): Linux/macOS tests and Linux render passed.

## Confirmed scope extension

The user included both existing editors and approved Video Studio as the shared
name. The podcast source snapshot is `apollo-robotics@e487493b3382943e10185ba015042daebe5860c2`.
See [ADR 0002](../docs/adr/0002-two-editors-in-video-studio.md). Scope remains a bounded
extraction: separate APIs/project formats, shared pinned tools, two portable skills.

- Runtime and sidecar migration behavior: complete and locally verified.
- Podcast synthetic media/export/HTTP verification: complete.
- Combined Node tests: 68 pass; both skills validated.
- Publication of both editors: complete at commit `0826def`; [combined CI](https://github.com/polomodov/video-studio/actions/runs/42179910437) passed.
- [Apollo PR #389](https://github.com/polomodov/apollo-robotics/pull/389) contains the two compatibility entry points and removes duplicate implementations; review/merge remains a separate maintainer action.
