---
project: devkit-cli
goal: A developer productivity CLI written in TypeScript that manages local dev environment state, secrets, and service health checks
stack: [typescript, node, vitest]
phases:
  - id: scaffold
    name: Project scaffold
    tasks:
      - npm init with TypeScript 5, tsx for dev, tsup for building a CJS+ESM bundle with a bin entry
      - Commander.js for CLI parsing; chalk for colour output; a `devkit --version` command
      - Vitest with one passing unit test
      - CI-style check script in package.json that runs build + test + type-check
    checks:
      - file_exists: package.json
      - file_exists: src/index.ts
      - cmd: npm install --no-audit --no-fund
      - cmd: npm run build
      - cmd: npm test -- --run
      - cmd: node dist/index.cjs --version
    done_when: CLI builds, version flag works, test passes

  - id: config
    name: Config and secrets management
    depends_on: [scaffold]
    tasks:
      - `devkit init` creates ~/.devkit/config.json (chmod 600) with project name, default services
      - `devkit secret set KEY VALUE` encrypts and stores in ~/.devkit/secrets (AES-256-GCM, key derived from machine ID)
      - `devkit secret get KEY` decrypts and prints; `devkit secret list` shows key names without values
      - `devkit secret rm KEY` removes an entry
      - Unit tests for encrypt/decrypt round-trip; integration test for init idempotency
    checks:
      - cmd: npm test -- --run
      - cmd: npm run build && node dist/index.cjs secret set TEST_KEY test_value && node dist/index.cjs secret get TEST_KEY | grep -q test_value
    done_when: Secrets are stored encrypted, init is idempotent, all tests pass

  - id: healthcheck
    name: Service health checks
    depends_on: [config]
    tasks:
      - `devkit health` reads a .devkit.yaml in the current directory listing services (http URL, TCP host:port, shell command)
      - Runs checks in parallel with a configurable timeout; colour-coded output (✓ green, ✗ red)
      - `devkit health --json` outputs a JSON report
      - Exit code 0 if all pass, 1 if any fail (useful in CI scripts)
      - Unit tests for the check runner; integration test with a mock HTTP server (using undici MockAgent)
    checks:
      - cmd: npm test -- --run
      - cmd: npm run build && node dist/index.cjs health --json | node -e "const d=require('fs').readFileSync('/dev/stdin','utf8'); JSON.parse(d); process.exit(0)"
    done_when: Health checks work, JSON output is valid, exit codes are correct

  - id: publish
    name: Package and release prep
    depends_on: [healthcheck]
    tasks:
      - .npmignore excludes src/, tests/, *.test.ts
      - README.md with install instruction, quick-start and all command examples
      - Semantic version bump helper `devkit version patch|minor|major` that updates package.json and creates a git tag
      - `npm pack --dry-run` should include only dist/ and README.md
    checks:
      - cmd: npm test -- --run
      - cmd: npm run build
      - cmd: npm pack --dry-run 2>&1 | grep -q "dist/"
      - file_exists: README.md
    done_when: Package is publish-ready; README documents every command

# Notes for the engine
# - Never write secrets in plaintext; use the encrypt helper for every secret store operation
# - The CLI must run on Node 20+ on macOS, Linux and Windows (no OS-specific APIs unless guarded)
# - Keep dependencies minimal: Commander.js, chalk, and standard node: modules only for the core
# - All async operations use native async/await; no callbacks
---

Build a developer CLI tool. Prioritise correctness and cross-platform compatibility over features.
