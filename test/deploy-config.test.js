/**
 * Deploy-configuration tests (final wiring pass).
 *
 * A Dockerfile cannot be BUILT here — there is no container runtime in this
 * sandbox — so these tests verify the things that are checkable without one, and
 * they are chosen to catch the failures that actually happen:
 *
 *   1. DRIFT between the deploy config and the code. The image declares a port, a
 *      bind host, a data directory and a health endpoint; every one of those is
 *      also a value in src/. If someone changes DEFAULT_PORT or renames /healthz,
 *      the image silently stops matching the server and the container fails its
 *      probe on the host instead of failing here.
 *   2. A COPY path that does not exist. This is the single most common reason a
 *      Dockerfile fails on first build, and it is fully checkable offline: every
 *      COPY source is resolved against the DOCUMENTED build context (the PARENT of
 *      this repo, because package.json declares `plumby` as `file:../plumby`).
 *   3. Documentation that contradicts the code — an env var the docs promise but
 *      nothing reads, or a default the docs state wrongly.
 *
 * WHAT THESE TESTS DO NOT PROVE: that the image builds, that the container CLI
 * download works, or that the platform runs under a real container runtime. Only a
 * real deploy proves that; docs/DEPLOY.md says so explicitly.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_PORT, DEFAULT_HOST } from '../src/server/start.js';
import { OIDC_ENV_VARS } from '../src/auth/oidc-verifier.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** The DOCUMENTED build context: the parent holding both this repo and plumby. */
const BUILD_CONTEXT = path.dirname(REPO_ROOT);
const REPO_DIR_NAME = path.basename(REPO_ROOT);

const dockerfile = fs.readFileSync(path.join(REPO_ROOT, 'Dockerfile'), 'utf8');
const deployDoc = fs.readFileSync(path.join(REPO_ROOT, 'docs', 'DEPLOY.md'), 'utf8');
const readme = fs.readFileSync(path.join(REPO_ROOT, 'README.md'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));

/** All ENV assignments in the Dockerfile, flattened to a single map. */
function dockerEnv() {
  const env = {};
  // Handles `ENV A=1`, `ENV A=1 B=2`, and line-continued multi-assignments.
  const joined = dockerfile.replace(/\\\r?\n\s*/g, ' ');
  for (const line of joined.split('\n')) {
    const m = /^\s*ENV\s+(.*)$/.exec(line);
    if (!m) continue;
    for (const pair of m[1].split(/\s+/)) {
      const eq = pair.indexOf('=');
      if (eq > 0) env[pair.slice(0, eq)] = pair.slice(eq + 1).replace(/^["']|["']$/g, '');
    }
  }
  return env;
}

// ------------------------------------------------- the image matches the server

test('the image PORT/HOST match the server defaults (no deploy-config drift)', () => {
  const env = dockerEnv();
  assert.equal(env.PORT, String(DEFAULT_PORT), 'the image port must match DEFAULT_PORT');
  assert.equal(env.HOST, DEFAULT_HOST, 'the image bind host must match DEFAULT_HOST');
  // 0.0.0.0 specifically: a loopback bind inside a container is unreachable via -p.
  assert.equal(env.HOST, '0.0.0.0');
  // EXPOSE must agree with the port actually bound.
  assert.match(dockerfile, new RegExp(`^EXPOSE\\s+${DEFAULT_PORT}\\s*$`, 'm'));
});

test('the HEALTHCHECK probes the real unauthenticated route on the real port', () => {
  const healthcheck = /HEALTHCHECK[\s\S]*?CMD ([^\n]*)/.exec(dockerfile);
  assert.ok(healthcheck, 'the image must declare a HEALTHCHECK');
  const cmd = healthcheck[1];
  // The route the server actually serves without credentials.
  assert.match(cmd, /\/healthz/);
  assert.match(dockerfile, /process\.env\.PORT\|\|8080/, 'the probe must honor PORT');
  // Probes a CONNECT address, not the 0.0.0.0 bind address.
  assert.match(cmd, /127\.0\.0\.1/);
  assert.ok(!cmd.includes('0.0.0.0'), 'a healthcheck must not connect to the bind wildcard');
  // The route exists in the server, spelled the same way.
  const server = fs.readFileSync(path.join(REPO_ROOT, 'src', 'server', 'builder-server.js'), 'utf8');
  assert.match(server, /pathname === '\/healthz'/);
});

test('the image starts the platform through the package start script', () => {
  assert.match(dockerfile, /^CMD \["npm", "start"\]\s*$/m);
  assert.equal(pkg.scripts.start, 'node src/server/start.js');
  // The entry point the script names really exists.
  assert.ok(fs.existsSync(path.join(REPO_ROOT, 'src', 'server', 'start.js')));
});

test('the durable data directory is a declared VOLUME, matching AAB_DATA_DIR', () => {
  const env = dockerEnv();
  assert.ok(env.AAB_DATA_DIR, 'the image must set AAB_DATA_DIR');
  assert.ok(path.isAbsolute(env.AAB_DATA_DIR), 'the data dir must be absolute');
  // Losing this path loses every Project, so it must not be trapped in the layer.
  assert.ok(
    dockerfile.includes(`VOLUME ["${env.AAB_DATA_DIR}"]`),
    `AAB_DATA_DIR (${env.AAB_DATA_DIR}) must be declared as a VOLUME`,
  );
  // ...and it must be writable by the non-root runtime user.
  assert.match(dockerfile, /chown -R node:node/);
  assert.match(dockerfile, /^USER node\s*$/m);
});

test('no credential is baked into the image', () => {
  // Every secret arrives at run time. A literal key in an ENV/ARG would ship it to
  // anyone who can pull the image.
  for (const name of [...OIDC_ENV_VARS, 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'OPENROUTER_API_KEY']) {
    const assigned = new RegExp(`^\\s*(ENV|ARG)\\s+.*\\b${name}=`, 'm');
    assert.ok(!assigned.test(dockerfile), `${name} must not be assigned in the Dockerfile`);
  }
});

// --------------------------------------------- every COPY source really exists

test('every Dockerfile COPY source exists in the documented build context', () => {
  // The commonest first-build failure, and fully checkable offline. Sources are
  // resolved against the PARENT directory, which is the documented context because
  // package.json declares plumby as file:../plumby.
  const copies = [];
  for (const line of dockerfile.replace(/\\\r?\n\s*/g, ' ').split('\n')) {
    const m = /^\s*COPY\s+(.*)$/.exec(line);
    if (!m) continue;
    if (/--from=/.test(m[1])) continue; // in-image path from an earlier stage
    const parts = m[1].trim().split(/\s+/);
    // Last token is the destination; everything before it is a source.
    copies.push(...parts.slice(0, -1));
  }

  assert.ok(copies.length > 0, 'expected the Dockerfile to COPY application sources');
  for (const src of copies) {
    const resolved = path.join(BUILD_CONTEXT, src);
    assert.ok(
      fs.existsSync(resolved),
      `COPY source ${JSON.stringify(src)} does not exist at ${resolved} — the build would fail`,
    );
  }

  // Both halves must be copied: this repo AND the plumby sibling it imports.
  assert.ok(copies.some((c) => c.startsWith('plumby/')), 'the plumby engine must be copied');
  assert.ok(copies.some((c) => c.startsWith(`${REPO_DIR_NAME}/`)), 'the platform sources must be copied');
});

test('the file: dependency on plumby is why the context is the parent', () => {
  // If this ever becomes a registry dependency, the parent-context requirement (and
  // the docs and COPY paths that follow from it) should be revisited.
  assert.equal(pkg.dependencies.plumby, 'file:../plumby');
  assert.ok(fs.existsSync(path.join(BUILD_CONTEXT, 'plumby', 'package.json')));
  assert.match(dockerfile, /BUILD CONTEXT IS THE PARENT DIRECTORY/);
  assert.match(deployDoc, /Build context is the parent directory/i);
});

// ------------------------------------------------- docs match the code they document

test('DEPLOY.md documents every environment variable the code actually reads', () => {
  // A variable the code reads but the docs omit is an undiscoverable knob; the
  // reverse is a promise the code does not keep.
  const composeRuntime = fs.readFileSync(path.join(REPO_ROOT, 'src', 'server', 'compose-runtime.js'), 'utf8');
  const startJs = fs.readFileSync(path.join(REPO_ROOT, 'src', 'server', 'start.js'), 'utf8');
  const sources = composeRuntime + startJs;

  const read = new Set();
  for (const m of sources.matchAll(/env\.([A-Z][A-Z0-9_]+)/g)) read.add(m[1]);
  assert.ok(read.size > 0, 'expected env reads to be discoverable');

  for (const name of read) {
    assert.ok(deployDoc.includes(name), `${name} is read by the code but absent from docs/DEPLOY.md`);
  }
  // The identity variables live in the auth module; they must be documented too.
  for (const name of OIDC_ENV_VARS) {
    assert.ok(deployDoc.includes(name), `${name} is absent from docs/DEPLOY.md`);
  }
});

test('DEPLOY.md states the fail-closed posture and the honest limits', () => {
  // These are the claims a reader most needs to be true.
  assert.match(deployDoc, /fail-closed/i);
  // Product limits this wiring pass must not imply away.
  assert.match(deployDoc, /package installs cannot work/i);
  // The Preview follow-up is DONE, so the doc must no longer claim otherwise —
  // but it must still be honest about the two things that replaced that claim:
  // the default is still the inert placeholder, and the live path is a decision
  // with an egress consequence that only a container host can confirm.
  assert.match(deployDoc, /AAB_PREVIEW_NETWORK/, 'the knob that makes a Preview real must be documented');
  assert.match(deployDoc, /preview\.local/, 'the inert default must still be described as a placeholder');
  assert.match(
    deployDoc,
    /only a real container host can prove/i,
    'the container-host-only claims must stay separated from what tests prove',
  );
  // The verified-by-test versus needs-a-real-deploy split.
  assert.match(deployDoc, /require a real deploy/i);
  // The socket mount is a privilege decision, not a checkbox.
  assert.match(deployDoc, /root-equivalent/i);
});

test('the README points at the deploy guide and does not oversell the state', () => {
  assert.match(readme, /docs\/DEPLOY\.md/);
  assert.match(readme, /fail-closed/i);
  // The stale "implementation is next" line must not come back.
  assert.ok(
    !/Implementation tasks are the next step/i.test(readme),
    'the spec is implemented; the README must not say implementation is pending',
  );
});


// ------------------------------- the invariants a green build would still break

/**
 * Parse `COPY --from=<stage> <src> <dest>` lines, resolving each destination
 * against the WORKDIR in effect at that point in the file.
 */
function crossStageCopies() {
  const out = [];
  let workdir = '/';
  for (const raw of dockerfile.replace(/\\\r?\n\s*/g, ' ').split('\n')) {
    const wd = /^\s*WORKDIR\s+(\S+)\s*$/.exec(raw);
    if (wd) {
      workdir = path.posix.resolve(workdir, wd[1]);
      continue;
    }
    const m = /^\s*COPY\s+--from=(\S+)\s+(\S+)\s+(\S+)\s*$/.exec(raw);
    if (!m) continue;
    out.push({ stage: m[1], src: m[2], dest: path.posix.resolve(workdir, m[3]) });
  }
  return out;
}

test('the image preserves the plumby layout the installed symlink depends on', () => {
  // npm installs a file: dependency as a RELATIVE SYMLINK
  // (node_modules/plumby -> ../../plumby), not a copy. Copying node_modules across
  // stages only keeps that link valid if the runtime image reproduces the same
  // relative distance between node_modules and plumby. Get it wrong and the build
  // is green, the tests are green, and EVERY request fails with
  // ERR_MODULE_NOT_FOUND — so the invariant is asserted here rather than trusted.
  const linkPath = path.join(REPO_ROOT, 'node_modules', 'plumby');
  let target;
  try {
    target = fs.readlinkSync(linkPath);
  } catch {
    // Not a symlink (npm may have copied on some platforms) — nothing to pin.
    return;
  }

  const copies = crossStageCopies();
  const nodeModules = copies.find((c) => c.dest.endsWith('/node_modules'));
  const plumby = copies.find((c) => c.src.endsWith('/plumby') && !c.src.includes('node_modules'));
  assert.ok(nodeModules, 'the runtime stage must copy node_modules from the deps stage');
  assert.ok(plumby, 'the runtime stage must copy the plumby engine from the deps stage');

  // Where the symlink will point once node_modules sits at its runtime path...
  const resolvedFromLink = path.posix.resolve(nodeModules.dest, target);
  // ...must be exactly where plumby is placed.
  assert.equal(
    resolvedFromLink,
    plumby.dest,
    `node_modules/plumby -> ${target} resolves to ${resolvedFromLink}, but the image puts plumby at ` +
      `${plumby.dest}; the symlink would dangle and every request would fail at run time`,
  );
});

test('the image installs every external binary the platform shells out to', () => {
  // The platform execs binaries that node:*-slim does not ship. A missing one does
  // not fail the build and may not even crash — the snapshot path swallows ENOENT
  // into a structured failure — so it must be pinned here.
  const srcDir = path.join(REPO_ROOT, 'src');
  const binaries = new Set();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) {
        const text = fs.readFileSync(full, 'utf8');
        for (const m of text.matchAll(/(?:execFileSync|execFile|spawnSync|spawn)\(\s*'([a-z][a-z0-9_-]*)'/g)) {
          binaries.add(m[1]);
        }
      }
    }
  };
  walk(srcDir);

  assert.ok(binaries.size > 0, 'expected to find at least one shelled-out binary');

  // Only the RUNTIME stage matters: an install in an earlier stage ships nothing
  // to the final image unless it is explicitly COPY'd across, so asserting against
  // the whole file would pass while the image the operator runs has no binary.
  const runtimeStart = dockerfile.search(/^FROM\s+\S+\s+AS\s+runtime\s*$/m);
  assert.ok(runtimeStart >= 0, 'expected a stage named `runtime`');
  const runtimeStage = dockerfile.slice(runtimeStart);

  for (const bin of binaries) {
    if (bin === 'docker') continue; // configurable via CONTAINER_BIN; copied from its own stage
    assert.match(
      runtimeStage,
      new RegExp(`apt-get install[^\\n]*\\b${bin}\\b`),
      `src/ execs ${JSON.stringify(bin)} but the RUNTIME stage never installs it — ` +
        'the failure would appear at run time, possibly silently',
    );
  }
  // git specifically: exec'd on every passing turn by the SnapshotStore.
  assert.ok(binaries.has('git'), 'expected the SnapshotStore git shell-out to be discoverable');
});

test('the container CLI download cannot ship a truncated binary', () => {
  // `curl | tar` under sh has no pipefail: a transfer that dies after tar writes its
  // member exits 0 and produces a truncated CLI, which surfaces only as
  // 503 SANDBOX_ACQUIRE_FAILED at run time.
  assert.ok(!/curl[^\n]*\|\s*tar/.test(dockerfile), 'do not pipe curl straight into tar');
  assert.match(dockerfile, /curl -fsSL -o \S+/, 'download to a file');
  assert.match(dockerfile, /docker --version/, 'prove the extracted binary runs');
  // And a digest can be pinned for the binary that gets the host socket.
  assert.match(dockerfile, /DOCKER_CLI_SHA256/);
  assert.match(dockerfile, /sha256sum -c -/);
});

test('the deploy recipes do not publish the API in cleartext or lose state on reboot', () => {
  // The doc mandates https for OIDC_REDIRECT_URI, so the app port must not also be
  // reachable directly: -p 8080:8080 binds every host interface through DNAT rules
  // a host firewall does not filter.
  // Scoped to the RUNNABLE command blocks: prose is allowed (and expected) to
  // mention the unsafe form in order to warn against it.
  const commands = [...deployDoc.matchAll(/```(?:bash|sh)\n([\s\S]*?)```/g)].map((m) => m[1]).join('\n');
  assert.ok(commands.length > 0, 'expected runnable command blocks in the deploy guide');
  // Assert the SHAPE of every publish flag rather than blacklisting one spelling:
  // `-p 8080:8080`, `-p 0.0.0.0:8080:8080` and `-p 8080` are all publicly bound.
  // Line-leading `-p` only: that is the docker-run continuation style, and it keeps
  // unrelated flags such as `mkdir -p` out of the match.
  const publishes = [...commands.matchAll(/^\s+-p\s+(\S+)/gm)].map((m) => m[1]);
  assert.ok(publishes.length > 0, 'expected a published port in the container recipe');
  for (const spec of publishes) {
    assert.ok(
      spec.startsWith('127.0.0.1:'),
      `published port ${JSON.stringify(spec)} must be bound to 127.0.0.1 so the reverse proxy is the only entrance`,
    );
  }
  assert.match(commands, /-p 127\.0\.0\.1:8080:8080/);

  // The container must NOT inherit the systemd shape's loopback bind: it would make
  // the published port dead while the healthcheck (which probes container-local
  // loopback) still reported healthy.
  assert.match(commands, /-e HOST=0\.0\.0\.0/);
  // Survive a host reboot, matching Restart=always in the unit file. Asserted on
  // the runnable block, not the prose that explains it.
  assert.match(commands, /--restart unless-stopped/);
  assert.match(deployDoc, /Restart=always/);
  // The data dir must be an identical-path host bind mount under a socket mount.
  assert.match(commands, /-v \/var\/lib\/ai-app-builder:\/var\/lib\/ai-app-builder/);
  assert.ok(
    !/-v aab-data:/.test(commands),
    'a named volume breaks sandbox bind-mount paths when the host daemon resolves them',
  );
  // ...and the reason is explained, not just prescribed.
  assert.match(deployDoc, /host's\*\* daemon|host's daemon/);
});

test('the docs restrict the permissions of the directory holding secrets', () => {
  // AAB_DATA_DIR holds project secrets, the registry and snapshots, and the stores
  // write under the ambient umask.
  assert.match(deployDoc, /UMask=0077/, 'the systemd unit should restrict the umask');
  assert.match(deployDoc, /chmod 700 \/var\/lib\/ai-app-builder/, 'the bind-mount path should be 0700');
  assert.match(dockerfile, /chmod 700 "\$\{AAB_DATA_DIR\}"/, 'the image data dir should be 0700');
});
