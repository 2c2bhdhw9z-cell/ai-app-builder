---
name: secret-hygiene
description: Keep credentials out of source code and logs. Use when adding an API key, database password, or token to a project; when reviewing code that touches a third-party service; or when a secret may have been committed by mistake. Covers referencing secrets by environment-variable name, never logging them, and what to do when one leaks.
license: MIT
metadata:
  version: "1.0.0"
---

# Secret hygiene

A secret in source control is a secret you must assume is compromised. Treat the repository, the
build logs, and the error tracker as public.

## Reference by name, never by value

Read credentials from the environment at runtime (`process.env.API_KEY`) and reference only the
NAME in source. The value is injected by the platform or the deployment environment. A literal
key in a file is one `git push` away from a public mirror.

- Keep a `.env.example` with the NAMES and no values, so a new contributor knows what to set.
- Add `.env` and any local secret file to `.gitignore` before the first commit, not after.

## Never log a secret

Redact credentials before they reach a log line, an audit record, or an error message. A stack
trace that echoes a request header will happily print a bearer token into a log aggregator that
a much wider audience can read.

## When one leaks

Rotate first, scrub second. Removing the commit does not help — it is already cloned and cached.
Revoke or rotate the exposed credential immediately, then clean history if you must. Rotation is
the fix; history rewriting is cleanup.
