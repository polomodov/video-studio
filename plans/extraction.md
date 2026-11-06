# Standalone Shorts Studio extraction

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

- Confirmed public repository: `polomodov/shorts-studio`.
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
| Publication | Public source-only repository, license, CI and clone verified | Pending |
| Original-repo migration | Launcher/skill route to the standalone checkout | Implemented; awaiting PR |

## Validation

Planned: Node tests, Python helper entry points and adapter behavior, shell
syntax, isolated launcher startup, real synthetic HTTP render/download/full
decode with caption-frame inspection, repository content/link review, and CI.
Record actual results in [validation.md](../docs/validation.md), distinguishing
synthetic fixtures from real ASR and model selection.

## Change links

- [Public repository](https://github.com/polomodov/shorts-studio)
- [Source mise PR](https://github.com/polomodov/apollo-robotics/pull/387)
- Original-repository migration PR: pending publication.
