---
project: demo
goal: Walk through the whole Meadow flow without a real engine or LLM
stack: [shell]
phases:
  - id: hello
    name: Say hello
    tasks:
      - Create hello.txt
    checks:
      - file_exists: hello.txt
      - cmd: test -s hello.txt
    done_when: hello.txt exists and is not empty
  - id: world
    name: Say world
    depends_on: [hello]
    tasks:
      - Create world.txt
    checks:
      - file_exists: world.txt
      - cmd: test -f hello.txt && test -f world.txt
    done_when: Both files exist
---

Run with `MEADOW_ENGINE=fake meadow run examples/DEMO-PLAN.md`.
