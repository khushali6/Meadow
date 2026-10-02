# Security

Meadow runs coding agents on your machine with access to your project folders. This document describes what it protects against, how, and what it does not.

## Threat model

Meadow defends against:

- **Other websites in your browser** reaching the local dashboard (CSRF, DNS rebinding).
- **Other people on Telegram** talking to your bot.
- **The coding engine going off track**: editing the plan it is measured against, escaping the project folder through symlinks, committing secrets, mass-deleting files, or running forever.
- **Accidental secret leakage** into prompts, logs, events, screenshots or the search index.

Meadow does not defend against malware already running as your user, a compromised coding engine binary, or a compromised FreeLLMAPI gateway. The engines themselves execute code in your project with your user's permissions; Meadow supervises them but is not a sandbox.

## Controls

### Network

- Outbound traffic: the coding engine (its own provider), your FreeLLMAPI gateway, and the Telegram Bot API if configured. Nothing else.
- The FreeLLMAPI base URL must be a loopback address unless `MEADOW_ALLOW_REMOTE_LLM=1` is set.

### Dashboard

- Binds to `127.0.0.1` only.
- Rejects any request whose `Host` header is not `127.0.0.1`, `localhost` or `[::1]`.
- Every API route except `/api/health` requires the session token (`x-meadow-token` header, or `?token=` for event streams and images). The token is random, regenerated at each start, stored in `~/.meadow/session-token` with mode 0600, and compared in constant time.
- No CORS headers. `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, and a strict Content-Security-Policy in production.
- Error responses never include stack traces and are redacted.

### Telegram

- Pairing uses a one-time 6-digit code, stored only as a SHA-256 hash, valid for 15 minutes. The first account to send it becomes the owner.
- Messages from anyone else get no reply at all.
- The bot token is never sent in a message and never logged.

### Secrets

- Read only from environment variables or `~/.meadow/secrets.env` (mode 0600). Never from `config.json` or project folders.
- Known secret values and common key patterns are redacted from logs, events, check output and error messages.
- Prompts never include secrets, tokens or Telegram chat contents beyond the request itself.
- Child processes receive a minimal environment allowlist (`PATH`, `HOME`, locale, and the engine's own credential variables) rather than your full environment.

### Engine guards

After every engine run and before any commit:

- Edits to `PLAN.md`, `SPEC.md` or `.meadow/` are reverted.
- Symlinks pointing outside the project are removed and the attempt is blocked.
- Added lines matching secret patterns, or new credential files (`.env`, `*.pem`, `id_rsa`, …), block the commit.
- Deleting more files than the configured threshold pauses for approval. Approvals expire to **deny**.
- Dependency file changes are listed in the phase report.
- Each run has a total timeout and a no-output watchdog; the whole process group is killed.
- Token and wall-clock budgets per phase and per day.

### Git

- Each phase works on its own branch. Only verified phases are merged (fast-forward only) into your base branch.
- Rollback never deletes work: the failed branch is renamed to `failed/…` before resetting.

### Screenshots and search

- Screenshots are taken only from the preview URL declared in the plan, which must be localhost; navigation to any other origin is blocked. Pages whose text contains secret patterns are not saved.
- The search index permanently ignores `.env*`, key and certificate files, credential files, `node_modules`, build output and `.git`.

## Reporting a vulnerability

Please report security issues privately to the maintainers rather than opening a public issue. Include steps to reproduce and the output of `meadow doctor` with any secrets removed. We aim to respond within a week.
