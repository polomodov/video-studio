# Security and privacy

Video Studio contains two local, single-user editors. Their HTTP servers bind to `127.0.0.1` and validate Host/Origin. The podcast API requires its exact origin for POST requests. Do not expose it through a public reverse proxy or shared network service; it has no multi-user authentication or authorization model.

Source media is read from local paths. Shorts stores transcripts, job state, posters, and exports in its data root. Podcast montage stores an assembly and renders beside the source files in `.video-studio-montage`, or reuses a sole legacy `.apollo-montage` sidecar. Keep recording folders and both kinds of working data outside this source repository. Podcast montage does not call external model services or upload media. Codex selection sends transcript text and the recording title through the user's authenticated Codex CLI. Source video is not submitted by the selection workflow. Review the content you choose to process and the account's service settings.

Both editors invoke external media tools without a shell. Shorts restricts candidate selection to structured output. It disables Codex tools and uses an isolated working directory. These boundaries are part of the application and should remain covered when changing the selector or server.

## Reporting a vulnerability

Use the repository's [private vulnerability reporting page](https://github.com/polomodov/video-studio/security/advisories/new) if that feature is enabled. If it is unavailable, open a minimal issue asking the maintainer for a private reporting channel; do not include exploit details, private transcripts, paths, or credentials in a public issue.

Provide the affected revision, OS/runtime versions, and a reproduction with generated data. Do not send real media or authentication files. There is no guaranteed response time or long-term security support policy for this early project.
