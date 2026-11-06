# Security and privacy

Shorts Studio is a local, single-user application. Its HTTP server binds to `127.0.0.1`, validates Host/Origin, and rejects cross-site requests. Do not expose it through a public reverse proxy or shared network service; it has no multi-user authentication or authorization model.

Source media is read from local paths. The application stores transcripts, job state, posters, and exports in a local data directory. Codex selection sends transcript text and the recording title through the user's authenticated Codex CLI. Source video is not submitted by the selection workflow. Review the content you choose to process and the account's service settings.

The code invokes external tools without a shell and restricts candidate selection to structured output. It disables Codex tools and uses an isolated working directory. These boundaries are part of the application and should remain covered when changing the selector or server.

## Reporting a vulnerability

Use the repository's [private vulnerability reporting page](https://github.com/polomodov/shorts-studio/security/advisories/new) if that feature is enabled. If it is unavailable, open a minimal issue asking the maintainer for a private reporting channel; do not include exploit details, private transcripts, paths, or credentials in a public issue.

Provide the affected revision, OS/runtime versions, and a reproduction with generated data. Do not send real media or authentication files. There is no guaranteed response time or long-term security support policy for this early project.
