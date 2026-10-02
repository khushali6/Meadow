# Changelog

## 1.0.0

First local release.

- Local daemon (`meadow start`) with a token-protected dashboard on 127.0.0.1.
- Request pipeline: classify, gather context, up to five clarifying questions, SPEC.md, PLAN.md, approval.
- Harness: one branch per phase, real checks (`cmd`, `file_exists`, `http`), fix loop with real error output, stuck detection, retry with hint, skip, rollback, pause and resume, crash recovery.
- Guards for plan tampering, escaping symlinks, secrets in diffs, mass deletions (approval with expiry-to-deny), dependency changes.
- Engines: Cursor CLI and Claude Code (optionally through FreeLLMAPI), plus a fake engine for demos and tests.
- FreeLLMAPI for all agent LLM work: planning, summaries, embeddings, voice transcription.
- Telegram: owner pairing, text and voice requests, inline buttons, phase cards with screenshots, quiet hours, notification levels.
- Screenshots of the localhost preview (desktop and mobile) with Playwright.
- Local search index over code and notes.
- CLI: `init`, `doctor`, `start`, `run`, `plan validate`, `status`, `pair`, `export-run`.
