/**
 * self-hosted-deploy.js — a REAL, VENDOR-NEUTRAL deploy behind the existing
 * `deployBoundary` seam of src/project/build-service.js (Req 18.4, 18.6).
 *
 * WHAT THIS REPLACES. `build-service.js` already implements the deploy LIFECYCLE
 * for real — the CommandGuard-gated consent path, the 120s SLO on the injected
 * clock, and the no-partial-state guarantee that a failed deploy leaves the prior
 * deployed state untouched. But its ONE actual work boundary was inert:
 * `defaultDeployBoundary` synthesized `https://<id>-<target>.hosting.local` and
 * pushed nothing, so a caller was handed a URL that could never answer. This
 * module implements the SAME seam for real:
 *
 *     deploy({ projectId, artifact, destination, timeoutMs, signal })
 *        -> { ok, url?, exitStatus?, stderr?, ... }
 *
 * so `createBuildService` is untouched and the two implementations are
 * interchangeable — exactly how `container-dev-server.js` gave the previously inert
 * Dev_Server seam a real implementation.
 *
 * ============ WHY SELF-HOSTED IS THE FIRST-CLASS TARGET (anti-lock-in) ==========
 * The platform exists to be owned outright, and "deploy" is the single most
 * effective place to install an exit tax: bind it to one hosting vendor's SDK and
 * credentials and leaving costs a rewrite. So the FIRST-CLASS deploy target is the
 * platform ITSELF: the built artifact is published to a control-plane location the
 * platform serves, and the URL returned is one the platform answers. No third-party
 * SDK, no vendor credentials, no new dependency — Node stdlib only.
 *
 * EXTERNAL PROVIDERS STAY BEHIND THIS SAME SEAM. A Vercel/Netlify/S3/registry
 * adapter is a FUTURE implementation of `deployBoundary` — one narrow, replaceable
 * module, selected by configuration, reimplementing nothing of this one. That is
 * the anti-lock-in boundary rule (one owned seam per vendor), and it is why an
 * unrecognized `destination` is REFUSED here rather than silently self-hosted: a
 * caller that asked for a provider must not be told a different deploy succeeded.
 *
 * ================== HOW A PUBLISH IS ATOMIC (no partial state) =================
 * A publish writes a WHOLE new release directory beside the live one and only then
 * flips a `current` symlink into place with a single `rename` — the one operation
 * POSIX gives us that atomically replaces a name. So:
 *   - every failure mode (unreadable/foreign artifact, a write error, an unsafe
 *     path, a full disk) happens BEFORE the flip, leaving the previous release
 *     byte-for-byte unchanged and still served;
 *   - a reader never observes a half-written site, because it resolves through
 *     `current`, which only ever points at a complete release.
 * Old releases are pruned AFTER the flip, best effort, keeping the last few.
 *
 * =================== HOW A PUBLISHED SITE IS SERVED, SAFELY ====================
 * `lookup()` is the read side, consumed by the Builder_Server's `/live/...` route.
 * It is deliberately shaped so the SERVER does no filesystem work at all:
 *
 *   - the request's path is used ONLY as a KEY into the release's MANIFEST, which
 *     was written at publish time from the artifact's own file list. The request
 *     is never joined onto a path, so there is no traversal surface — the same
 *     discipline as the Builder_Server's fixed static-asset allow-list;
 *   - the resolved file is still containment-checked (resolve + realpath) against
 *     the release root, belt-and-braces;
 *   - a miss is a miss: no directory listing, no existence disclosure, nothing but
 *     `{ ok:false }` for a bad project, a bad signature, a missing release and an
 *     unlisted path alike;
 *   - the URL carries an unguessable, key-derived SIGNATURE over
 *     (ownerId, projectId, target). It is a capability, exactly like a ShareLink
 *     token: knowing a projectId is not enough, and nothing that required
 *     authorization before becomes reachable without it. A deployed site is meant
 *     to be openable in a browser, which a Bearer-gated URL could never be.
 *
 * WHAT THIS DOES NOT CLAIM. A published site is served as STATIC FILES by the
 * platform. It does not run a server process — `backend`/`mobile` Targets are
 * therefore REFUSED here rather than published as inert files under a URL that
 * would imply a running service. And because the platform serves the site from its
 * OWN origin, the Builder_Server serves published documents under an additionally
 * SANDBOXED Content-Security-Policy, so a generated page cannot execute script on
 * the platform's origin and read the platform's own session storage. A deployed app
 * whose JavaScript must actually run needs a separate origin; that is a documented
 * follow-up, not something this module pretends to do.
 *
 * THE PLUMBY BOUNDARY: this module never imports the plumby package.
 *
 * Conventions: a factory returning Object.freeze({...}); dependency injection for
 * the clock and every collaborator; structured results rather than throws.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { fail, requireString } from '../model/validate.js';
import { isValidTarget } from '../model/enums.js';
import { decodeArtifactBundle, isSafeRelativePath } from './container-build.js';

/** The URL path prefix a published site is served under. */
export const PUBLISHED_PATH_PREFIX = '/live';

/** The destination descriptors that mean "this platform serves it". */
export const SELF_HOSTED_DESTINATIONS = Object.freeze(['self-hosted', 'self', 'platform']);

/**
 * Targets a static self-hosted publish can honestly serve. A `backend` build is a
 * server, not a site, and a `mobile` build is an app binary — publishing either as
 * static files would be a URL that lies about what is running.
 */
export const PUBLISHABLE_TARGETS = Object.freeze(['web', 'shared']);

/** How many past releases are kept after a successful publish. */
export const DEFAULT_RELEASES_KEPT = 3;

/** Hex characters of HMAC output used as the URL capability signature (128 bits). */
export const SIGNATURE_HEX_LENGTH = 32;

/** The manifest format tag written into every release. */
export const MANIFEST_VERSION = 'aab-published/1';

/** The symlink name that always points at the live release. */
const CURRENT_LINK = 'current';
/** The directory holding every release for one project+target. */
const RELEASES_DIR = 'releases';
/** The manifest file inside a release. */
const MANIFEST_FILE = 'manifest.json';

/**
 * Content-Type by extension for served published files. A deliberately closed map:
 * an unknown extension is served as `application/octet-stream`, never sniffed.
 */
export const PUBLISHED_CONTENT_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
});

/** Content-Type for a published file, by extension only. */
export function publishedContentType(relPath) {
  const ext = path.extname(String(relPath ?? '')).toLowerCase();
  return PUBLISHED_CONTENT_TYPES[ext] ?? 'application/octet-stream';
}

/**
 * Build the manifest ENTRY map for a release: request path -> release-relative
 * file. PURE, so the served key set is testable directly.
 *
 * Keys are exactly what a browser will ask for:
 *   `dist/index.html`      -> '/index.html' and '/'          (the site root)
 *   `dist/about/index.html`-> '/about/index.html', '/about/', '/about'
 *   `dist/app.js`          -> '/app.js'
 * Nothing else is served — no directory listings, and no key that was not derived
 * from a file the build actually produced.
 *
 * @param {Array<{path:string}>} files
 * @returns {Record<string,string>}
 */
export function manifestEntriesFor(files) {
  const entries = {};
  for (const file of files ?? []) {
    const rel = file?.path;
    if (typeof rel !== 'string' || !isSafeRelativePath(rel)) continue;
    entries[`/${rel}`] = rel;
    const segments = rel.split('/');
    if (segments[segments.length - 1] === 'index.html') {
      const dir = segments.slice(0, -1).join('/');
      if (dir === '') {
        entries['/'] = rel;
      } else {
        entries[`/${dir}/`] = rel;
        entries[`/${dir}`] = rel;
      }
    }
  }
  return entries;
}

/** True when `candidate` is `root` or a descendant of it. */
function contained(root, candidate) {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  if (rel === '') return true;
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Constant-time comparison of two hex signatures of any length. */
function signaturesMatch(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

/**
 * Create the self-hosted deploy boundary + the read side that serves it.
 *
 * @param {object} args
 * @param {object} args.layout   a StorageLayout — supplies
 *        controlPublishedSitePath(ownerId, projectId, target). REQUIRED: published
 *        output is control-plane state, keyed per owner, never inside a project tree.
 * @param {(projectId:string)=>string|null} args.ownerOf  resolve a projectId's owning
 *        account. REQUIRED and never defaulted: without it every account's published
 *        output would land under one placeholder owner directory.
 * @param {string} args.signingKey  key the URL capability signature is derived from.
 *        REQUIRED. A caller that has none should generate one per process and say so
 *        (published URLs then change on restart) rather than using a constant.
 * @param {string} [args.baseUrl]  public origin to render an ABSOLUTE URL against.
 *        Omitted: a relative `/live/...` URL is returned (same choice the
 *        Share_Link surface makes).
 * @param {() => number} [args.now]  injectable ms clock.
 * @param {number} [args.releasesKept]
 * @param {object} [args.fsSeam]  { mkdirSync, writeFileSync, readFileSync, renameSync,
 *        symlinkSync, rmSync, readdirSync, statSync, realpathSync } — injected in tests.
 * @returns {object} frozen { deploy, lookup, urlFor, signatureFor, ... }
 */
export function createSelfHostedDeploy({
  layout,
  ownerOf,
  signingKey,
  baseUrl,
  now = () => Date.now(),
  releasesKept = DEFAULT_RELEASES_KEPT,
  fsSeam = fs,
} = {}) {
  const model = 'SelfHostedDeploy';
  if (!layout || typeof layout.controlPublishedSitePath !== 'function') {
    fail(model, 'a StorageLayout with controlPublishedSitePath(ownerId, projectId, target) is required');
  }
  if (typeof ownerOf !== 'function') {
    fail(model, 'ownerOf(projectId) is required so published output is written under the OWNING account');
  }
  requireString(model, 'signingKey', signingKey);
  if (typeof now !== 'function') fail(model, 'now must be a function returning ms');

  const publicBase = typeof baseUrl === 'string' && baseUrl.trim() !== '' ? baseUrl.trim().replace(/\/+$/, '') : null;

  /** The unguessable capability signature for one owner+project+target. */
  function signatureFor({ ownerId, projectId, target }) {
    return crypto
      .createHmac('sha256', signingKey)
      .update(`${ownerId}\n${projectId}\n${target}`, 'utf8')
      .digest('hex')
      .slice(0, SIGNATURE_HEX_LENGTH);
  }

  /** The URL a published project+target is served at. */
  function urlFor({ ownerId, projectId, target }) {
    const signature = signatureFor({ ownerId, projectId, target });
    const relative = `${PUBLISHED_PATH_PREFIX}/${encodeURIComponent(projectId)}/${encodeURIComponent(target)}/${signature}/`;
    return publicBase ? `${publicBase}${relative}` : relative;
  }

  /** A structured deploy FAILURE in the boundary's contract shape. */
  function failed({ code, message, exitStatus = 1 }) {
    return Object.freeze({
      ok: false,
      exitStatus,
      code,
      stderr: `${code}: ${message}`,
      message,
    });
  }

  /**
   * deploy({ projectId, artifact, destination, timeoutMs, signal }) — the
   * deployBoundary seam: publish a built artifact to a location this platform
   * serves and return the URL that serves it.
   *
   * Never throws on a handled path, and never touches the live release until a
   * complete new one exists on disk.
   */
  async function deploy({ projectId, artifact, destination } = {}) {
    requireString(model, 'projectId', projectId);

    // (0) DESTINATION. Self-hosted is the first-class target; anything else names a
    // provider adapter that does not exist yet, and is refused rather than quietly
    // published somewhere the caller did not ask for.
    if (destination !== undefined && destination !== null && destination !== '') {
      const wanted = String(destination).trim().toLowerCase();
      if (!SELF_HOSTED_DESTINATIONS.includes(wanted)) {
        return failed({
          code: 'UNSUPPORTED_DESTINATION',
          exitStatus: 78,
          message:
            `destination ${JSON.stringify(destination)} is not served by this platform. The first-class ` +
            `deploy target is self-hosted (${SELF_HOSTED_DESTINATIONS.join('/')}); an external hosting ` +
            'provider is a future adapter behind this same deployBoundary seam, so the deploy is REFUSED ' +
            'rather than published somewhere else.',
        });
      }
    }

    const target = artifact?.targetKind;
    if (typeof target !== 'string' || !isValidTarget(target)) {
      return failed({
        code: 'INVALID_ARTIFACT',
        exitStatus: 78,
        message: `the artifact declares no valid Target (got ${JSON.stringify(target ?? null)})`,
      });
    }
    if (!PUBLISHABLE_TARGETS.includes(target)) {
      return failed({
        code: 'TARGET_NOT_PUBLISHABLE',
        exitStatus: 78,
        message:
          `a self-hosted deploy serves STATIC files, so the ${target} Target cannot be published this way ` +
          `(publishable: ${PUBLISHABLE_TARGETS.join('/')}). Running a server process or shipping an app ` +
          'binary needs a host adapter behind this same seam; refusing rather than serving files under a ' +
          'URL that would imply a running service.',
      });
    }

    const ownerId = ownerOf(projectId);
    if (typeof ownerId !== 'string' || ownerId === '') {
      return failed({
        code: 'NO_OWNER',
        exitStatus: 78,
        message:
          `project ${JSON.stringify(projectId)} resolves to no owning account, so published output has no ` +
          'per-owner location to be written to; refusing rather than publishing under a placeholder owner',
      });
    }

    // (1) READ THE ARTIFACT. An unreadable or foreign artifact fails here, with the
    // live release untouched.
    let raw;
    try {
      raw = fsSeam.readFileSync(artifact.path, 'utf8');
    } catch (err) {
      return failed({
        code: 'ARTIFACT_UNREADABLE',
        message: `the Deployment_Artifact bytes could not be read: ${err?.message ?? err}`,
      });
    }
    const decoded = decodeArtifactBundle(raw);
    if (decoded.ok !== true) {
      return failed({ code: decoded.code, exitStatus: 78, message: decoded.message });
    }
    if (decoded.files.length === 0) {
      return failed({ code: 'ARTIFACT_EMPTY', exitStatus: 78, message: 'the Deployment_Artifact contains no files to publish' });
    }

    const siteDir = layout.controlPublishedSitePath(ownerId, projectId, target);
    const releasesDir = path.join(siteDir, RELEASES_DIR);
    const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-');
    const releaseId = `${stamp}-${crypto.randomBytes(4).toString('hex')}`;
    const releaseDir = path.join(releasesDir, releaseId);

    // (2) STAGE A COMPLETE RELEASE beside the live one. Everything that can fail
    // happens here, before anything the served site resolves through is touched.
    let byteLength = 0;
    try {
      fsSeam.mkdirSync(releaseDir, { recursive: true });
      for (const file of decoded.files) {
        const absolute = path.resolve(releaseDir, file.path);
        // Belt-and-braces: decodeArtifactBundle already rejected traversal, so this
        // can only fire if that check regressed — which is exactly when a publish
        // must stop rather than write outside the release.
        if (!contained(releaseDir, absolute)) {
          throw new Error(`refusing to write ${JSON.stringify(file.path)} outside the release directory`);
        }
        fsSeam.mkdirSync(path.dirname(absolute), { recursive: true });
        fsSeam.writeFileSync(absolute, file.bytes);
        byteLength += file.bytes.length;
      }

      const entries = manifestEntriesFor(decoded.files);
      if (!Object.prototype.hasOwnProperty.call(entries, '/')) {
        throw new Error(
          'the build output has no index.html at its root, so the published site would have no entry ' +
            'point; refusing rather than publishing a site whose URL serves nothing',
        );
      }
      fsSeam.writeFileSync(
        path.join(releaseDir, MANIFEST_FILE),
        JSON.stringify({
          version: MANIFEST_VERSION,
          releaseId,
          projectId,
          target,
          deployedAt: new Date(now()).toISOString(),
          fileCount: decoded.files.length,
          byteLength,
          entries,
        }),
        'utf8',
      );
    } catch (err) {
      // Roll the staging area back. The live release was never referenced, so the
      // previously deployed site is byte-for-byte unchanged and still served.
      try {
        fsSeam.rmSync(releaseDir, { recursive: true, force: true });
      } catch {
        /* best effort; a leftover staging dir is never served (nothing links to it) */
      }
      return failed({ code: 'PUBLISH_FAILED', message: `the release could not be staged: ${err?.message ?? err}` });
    }

    // (3) FLIP. One rename over the `current` symlink: the single atomic step.
    try {
      const pending = path.join(siteDir, `.${CURRENT_LINK}-${crypto.randomBytes(4).toString('hex')}`);
      fsSeam.symlinkSync(path.join(RELEASES_DIR, releaseId), pending);
      fsSeam.renameSync(pending, path.join(siteDir, CURRENT_LINK));
    } catch (err) {
      try {
        fsSeam.rmSync(releaseDir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
      return failed({
        code: 'PUBLISH_SWAP_FAILED',
        message: `the new release could not be made live: ${err?.message ?? err}`,
      });
    }

    // (4) PRUNE old releases, best effort and strictly AFTER the flip, so a prune
    // failure can never affect what is being served.
    pruneReleases(releasesDir, releaseId);

    return Object.freeze({
      ok: true,
      exitStatus: 0,
      url: urlFor({ ownerId, projectId, target }),
      stderr: '',
      target,
      releaseId,
      fileCount: decoded.files.length,
      byteLength,
      destination: 'self-hosted',
    });
  }

  /** Keep the newest `releasesKept` releases (always including `keepId`). */
  function pruneReleases(releasesDir, keepId) {
    try {
      const all = fsSeam
        .readdirSync(releasesDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
      const doomed = all.filter((name) => name !== keepId).slice(0, Math.max(0, all.length - releasesKept));
      for (const name of doomed) {
        try {
          fsSeam.rmSync(path.join(releasesDir, name), { recursive: true, force: true });
        } catch {
          /* best effort */
        }
      }
    } catch {
      /* best effort */
    }
  }

  /**
   * lookup({ projectId, target, signature, requestPath }) — the READ side the
   * Builder_Server's `/live/...` route calls.
   *
   * Returns the response BYTES, so the server performs no filesystem work and
   * therefore has no traversal surface of its own. Never throws: every miss —
   * malformed input, unknown project, wrong signature, no release, a path the
   * manifest does not list — is the SAME `{ ok:false }`, with no listing and no
   * existence disclosure.
   *
   * @returns {{ ok:true, body:Buffer, contentType:string, releaseId:string, path:string }
   *          | { ok:false }}
   */
  function lookup({ projectId, target, signature, requestPath } = {}) {
    const miss = Object.freeze({ ok: false });
    // Shape checks first: nothing malformed reaches the layout (whose id rules
    // would throw) or the filesystem.
    if (typeof projectId !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(projectId)) return miss;
    if (projectId === '.' || projectId === '..') return miss;
    if (typeof target !== 'string' || !PUBLISHABLE_TARGETS.includes(target)) return miss;
    if (typeof signature !== 'string' || !/^[0-9a-f]{8,128}$/.test(signature)) return miss;
    if (typeof requestPath !== 'string' || requestPath === '' || requestPath.includes('\0')) return miss;

    let ownerId;
    try {
      ownerId = ownerOf(projectId);
    } catch {
      return miss;
    }
    if (typeof ownerId !== 'string' || ownerId === '') return miss;
    if (!signaturesMatch(signature, signatureFor({ ownerId, projectId, target }))) return miss;

    let currentDir;
    let manifest;
    try {
      currentDir = fsSeam.realpathSync(path.join(layout.controlPublishedSitePath(ownerId, projectId, target), CURRENT_LINK));
      manifest = JSON.parse(fsSeam.readFileSync(path.join(currentDir, MANIFEST_FILE), 'utf8'));
    } catch {
      return miss;
    }
    if (!manifest || manifest.version !== MANIFEST_VERSION || !manifest.entries || typeof manifest.entries !== 'object') {
      return miss;
    }

    // THE ONLY use of the request path: a KEY lookup in the manifest written at
    // publish time. `hasOwnProperty` so an inherited key ('__proto__', 'toString')
    // can never resolve to a value.
    if (!Object.prototype.hasOwnProperty.call(manifest.entries, requestPath)) return miss;
    const rel = manifest.entries[requestPath];
    if (typeof rel !== 'string' || !isSafeRelativePath(rel)) return miss;

    const absolute = path.resolve(currentDir, rel);
    if (!contained(currentDir, absolute)) return miss;
    let real;
    let body;
    try {
      // Resolve symlinks BEFORE reading: a lexical check alone would let a link
      // inside a release read outside it.
      real = fsSeam.realpathSync(absolute);
      if (!contained(currentDir, real)) return miss;
      body = fsSeam.readFileSync(real);
    } catch {
      return miss;
    }

    return Object.freeze({
      ok: true,
      body,
      contentType: publishedContentType(rel),
      releaseId: typeof manifest.releaseId === 'string' ? manifest.releaseId : '',
      path: rel,
    });
  }

  return Object.freeze({
    deploy,
    lookup,
    urlFor,
    signatureFor,
    pathPrefix: PUBLISHED_PATH_PREFIX,
    publishableTargets: PUBLISHABLE_TARGETS,
    releasesKept,
    /** True when an ABSOLUTE URL is returned (a public base was configured). */
    absoluteUrls: publicBase !== null,
  });
}
