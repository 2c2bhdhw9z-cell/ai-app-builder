---
name: commit-hygiene
description: Write clear, reviewable commits and pull requests. Use when preparing a change for review, splitting a large diff into logical commits, or crafting a commit message that explains the why. Covers conventional-commit prefixes, atomic commits, and PR descriptions that a reviewer can read top to bottom.
license: MIT
metadata:
  version: "1.0.0"
---

# Commit hygiene

A commit is a message to a future reader — usually you, six months from now, trying to
understand why a line changed. Optimise for that reader.

## Atomic commits

One commit, one logical change. If the subject line needs an "and", it is probably two commits.
Refactors, formatting sweeps, and behavioural changes each get their own commit so a reviewer
can read the diff without untangling unrelated edits, and so a bad change can be reverted alone.

## The message

- **Subject** (≤ 72 chars): imperative mood, prefixed by type — `feat:`, `fix:`, `chore:`,
  `docs:`, `refactor:`, `test:`. "Add retry to the upload path", not "Added" or "Adds".
- **Body**: explain the *why*, not the *what*. The diff already shows what changed. The body
  says what problem it solves and what alternative you rejected.
- Reference the issue or ticket if there is one.

## Pull requests

Lead with the problem, then the approach, then anything the reviewer should look at closely.
Call out what you did NOT do and why. A PR the author has summarised honestly gets reviewed
faster than one that makes the reviewer reconstruct the intent from the diff.
