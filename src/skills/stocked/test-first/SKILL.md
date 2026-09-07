---
name: test-first
description: Drive a change with a failing test before writing the implementation. Use when fixing a bug, adding a feature with clear inputs and outputs, or hardening code that keeps regressing. Covers writing the smallest failing test, making it pass, then refactoring, and choosing what is worth testing versus what is not.
license: MIT
metadata:
  version: "1.0.0"
---

# Test first

Write the test that fails, make it pass, then clean up. The failing test proves the test can
detect the bug; a test that never failed proves nothing.

## The loop

1. **Red** — write one small test that describes the behaviour you want and watch it fail for
   the right reason (assertion, not a syntax error or a missing import).
2. **Green** — write the least code that makes it pass. Resist gold-plating.
3. **Refactor** — with the test green, improve names and structure. The test is your safety net.

## What to test

Test behaviour at the boundary of a unit: its inputs and its observable outputs, including the
error paths. Do not test private helpers directly — test them through the public surface, so a
refactor that keeps behaviour but moves code does not break the suite.

For a bug fix, the first test should reproduce the bug. If you cannot write a test that fails
because of the bug, you do not yet understand the bug.

## What not to test

Getters, framework wiring, and third-party libraries are usually not worth a unit test. Spend
the effort on the logic that is yours and that would be expensive to get wrong.
