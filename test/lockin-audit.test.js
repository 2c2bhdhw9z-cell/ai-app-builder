/**
 * Lockin_Audit tests (node --test) — spec Task 27.2, Req 11.1, 11.2, 11.3, 11.9,
 * 11.10, 11.11, 11.12, 11.13.
 *
 * These exercise REAL collaborators on fs.mkdtempSync temp dirs: a real
 * StorageLayout, a real PersistenceStore materializing a real on-disk tree with
 * PLANTED lock-in signals, the real default read seam walking that tree, and the
 * real in-process detectors. The clock is injected (a counter) so the 120s SLO
 * is a MEASURED budget, never a real wait. A CLEAN generated template (from the
 * real src/project/templates.js) is the positive control that each detector is
 * NOT a no-op.
 *
 * Every test is mutation-sensitive: it FAILS if the corresponding detection is
 * reverted. The documented detect-lockin.sh false-positive traps (Badge prose,
 * amplitude physics variable, structural importFrom with no vendor) are asserted
 * as NEGATIVE cases that must NOT be flagged.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

import { createStorageLayout } from '../src/storage/layout.js';
import { createPersistenceStore } from '../src/persistence/persistence-store.js';
import { createTemplateProvider } from '../src/project/templates.js';
import { createLockinAudit, AUDIT_SLO_MS } from '../src/portability/index.js';

const OWNER = 'owner-1';
const PROJECT = 'proj-1';

/** A layout rooted at a fresh temp dir, so real file I/O stays hermetic. */
function tempLayout() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-audit-test-'));
  return { base, layout: createStorageLayout(base) };
}

/** Persist a { relPath: contents } tree to disk (real PersistenceStore, immediate). */
function persistTree(layout, projectId, tree) {
  const store = createPersistenceStore({ layout, ownerId: OWNER, debounceMs: 0 });
  const res = store.persist(projectId, tree);
  assert.equal(res.ok, true, 'persist should succeed');
  return store;
}

/** A monotonic injected clock: each call advances by `stepMs`. */
function stepClock(stepMs = 0) {
  let t = 0;
  return () => {
    const v = t;
    t += stepMs;
    return v;
  };
}

/** Find the finding for a signal type, or undefined. */
function findBy(result, signal) {
  return result.findings.find((f) => f.signal === signal);
}

// --- each signal type is detected with path + line number (Req 11.10) -------

test('the audit detects each lock-in signal type with file path + line number', () => {
  const { base, layout } = tempLayout();
  try {
    const tree = {
      // telemetry SDK import (package-qualified) — line 2 of the file
      'src/telemetry.ts':
        '// boot\n' +
        "import posthog from 'posthog-js';\n" +
        'export const p = posthog;\n',
      // collector endpoint — line 1
      'src/collector.ts':
        "export const url = 'https://metrics.acme.io/collect';\n",
      // hardcoded platform host — line 1
      'src/host.ts':
        "export const api = 'https://platform.example.dev/api';\n",
      // enforcement importFrom rule naming the vendor — value on next line
      'conventions.json':
        '{\n  "must": {\n    "importFrom": [\n      "@acme/website-runtime"\n    ]\n  }\n}\n',
      // hash-protection manifest — the entry line
      'protected.json':
        '{\n  "protected": {\n    "src/app.tsx": "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2"\n  }\n}\n',
      // injected UI badge (JSX construct) — line 3
      'src/Footer.tsx':
        'export function Footer() {\n' +
        '  return (\n' +
        '    <PoweredBy />\n' +
        '  );\n' +
        '}\n',
      // env template with a declared-but-unread var
      '.env.template': 'USED_VAR=\nORPHAN_VAR=\n',
      // a file that reads USED_VAR (so only ORPHAN_VAR is unused)
      'src/config.ts': 'export const v = process.env.USED_VAR;\n',
    };
    persistTree(layout, PROJECT, tree);

    const audit = createLockinAudit({
      layout,
      now: stepClock(1),
      platformHosts: ['platform.example.dev'],
      vendorPattern: 'acme',
    });
    const result = audit.audit(PROJECT);
    assert.equal(result.ok, true);
    assert.equal(result.clean, false);

    const tel = findBy(result, 'telemetry');
    assert.ok(tel, 'telemetry signal detected');
    assert.equal(tel.file, 'src/telemetry.ts');
    assert.equal(tel.line, 2);

    const col = findBy(result, 'collector');
    assert.ok(col, 'collector signal detected');
    assert.equal(col.file, 'src/collector.ts');
    assert.equal(col.line, 1);

    const host = result.findings.find(
      (f) => f.signal === 'platform-host' && f.file === 'src/host.ts',
    );
    assert.ok(host, 'platform-host signal detected in src/host.ts');
    assert.equal(host.line, 1);

    const enf = findBy(result, 'enforcement');
    assert.ok(enf, 'enforcement rule detected');
    assert.equal(enf.file, 'conventions.json');
    assert.equal(enf.line, 4, 'the vendor value is on the next line (line 4)');

    const hash = findBy(result, 'hash-manifest');
    assert.ok(hash, 'hash-manifest signal detected');
    assert.equal(hash.file, 'protected.json');
    assert.equal(hash.line, 3);

    const ui = findBy(result, 'injected-ui');
    assert.ok(ui, 'injected UI badge detected');
    assert.equal(ui.file, 'src/Footer.tsx');
    assert.equal(ui.line, 3);

    const env = result.findings.filter((f) => f.signal === 'unused-env');
    assert.equal(env.length, 1, 'exactly one declared-but-unread env var');
    assert.equal(env[0].evidence, 'ORPHAN_VAR');
    assert.equal(env[0].file, '.env.template');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// --- injected <...Badge>/<...Watermark> JSX + undeclared host ---------------

test('injected <VendorBadge> JSX and an undeclared outbound host are flagged', () => {
  const audit = createLockinAudit({ now: stepClock(1) });
  const result = audit.audit(PROJECT, {
    tree: {
      'ui/Brand.tsx': '<VendorBadge />\n<AcmeWatermark />\n',
      'src/net.ts': "fetch('https://tracker.thirdparty.io/x');\n",
    },
  });
  assert.equal(result.ok, true);
  const ui = result.findings.filter((f) => f.signal === 'injected-ui');
  assert.equal(ui.length, 2, 'both JSX constructs flagged');
  const undeclared = result.findings.filter((f) => f.signal === 'undeclared-host');
  assert.ok(
    undeclared.some((f) => f.evidence === 'tracker.thirdparty.io'),
    'undeclared outbound host flagged',
  );
});

// --- unverified surface: a binary in-scope file is reported, not omitted -----

test('a binary / undecodable in-scope file is reported as an unverified surface', () => {
  const { base, layout } = tempLayout();
  try {
    // A Buffer with invalid utf8 bytes round-trips as binary (unscannable).
    const binary = Buffer.from([0xff, 0xfe, 0x00, 0x01, 0x80, 0x81]);
    persistTree(layout, PROJECT, {
      'assets/logo.bin': binary,
      'src/app.ts': 'export const x = 1;\n',
    });
    const audit = createLockinAudit({ layout, now: stepClock(1) });
    const result = audit.audit(PROJECT);
    assert.equal(result.ok, true);
    assert.equal(result.unverifiedSurfaces.length, 1, 'binary reported as unverified');
    assert.equal(result.unverifiedSurfaces[0].file, 'assets/logo.bin');
    assert.match(result.unverifiedSurfaces[0].reason, /binary|undecodable/i);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('an excluded path (node_modules) is a deliberate exclusion, NOT an unverified surface', () => {
  const audit = createLockinAudit({ now: stepClock(1) });
  const result = audit.audit(PROJECT, {
    tree: {
      // an SDK import copied under node_modules must NOT be flagged and must NOT
      // be an unverified surface — it is a deliberate exclusion.
      'node_modules/posthog-js/index.js': "import 'posthog-js';\n",
      'src/clean.ts': 'export const y = 2;\n',
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.clean, true, 'no findings from an excluded path');
  assert.equal(result.unverifiedSurfaces.length, 0, 'excluded path is not unverified');
});

// --- generated-code signal is a DEFECT (Req 11.13) --------------------------

test('a signal found in platform-generated code is treated as a defect', () => {
  const audit = createLockinAudit({ now: stepClock(1) });
  const result = audit.audit(PROJECT, {
    platformGenerated: true,
    tree: { 'src/t.ts': "import posthog from 'posthog-js';\n" },
  });
  assert.equal(result.ok, true);
  assert.equal(result.clean, false);
  assert.equal(result.platformGenerated, true);
  assert.equal(result.defect, true, 'generated-code signal marked as a defect');
  assert.match(result.summary, /DEFECT/);
  assert.ok(
    result.findings.every((f) => f.platformGenerated === true),
    'every finding flagged platformGenerated',
  );
});

// --- file-count limit (Req 11.9) --------------------------------------------

test('an over-limit project reports FILE_COUNT_EXCEEDED (no silent truncation)', () => {
  const tree = {};
  for (let i = 0; i < 5; i += 1) tree[`f${i}.ts`] = `export const n = ${i};\n`;
  const audit = createLockinAudit({ now: stepClock(1), fileCountLimit: 3 });
  const result = audit.audit(PROJECT, { tree });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'FILE_COUNT_EXCEEDED');
  assert.equal(result.count, 5);
  assert.equal(result.limit, 3);
});

// --- 120s SLO on the injected clock (Req 11.10) -----------------------------

test('an over-budget audit aborts with AUDIT_TIMEOUT on the injected clock', () => {
  // The clock jumps past the timeout between start and end (no real wait).
  const audit = createLockinAudit({
    now: stepClock(AUDIT_SLO_MS + 1),
    auditTimeoutMs: AUDIT_SLO_MS,
  });
  const result = audit.audit(PROJECT, { tree: { 'src/a.ts': 'export const a = 1;\n' } });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'AUDIT_TIMEOUT');
  assert.ok(result.auditMs > AUDIT_SLO_MS);
});

// --- incremental re-audit (Req 11.11) ---------------------------------------

test('an incremental re-audit reflects the current state (removed signal does not persist)', () => {
  const audit = createLockinAudit({ now: stepClock(1) });
  // Prior: two files, both with a telemetry signal.
  const prior = audit.audit(PROJECT, {
    tree: {
      'a.ts': "import posthog from 'posthog-js';\n",
      'b.ts': "import mixpanel from 'mixpanel-browser';\n",
    },
  });
  assert.equal(prior.findings.length, 2);

  // Current: a.ts had its signal REMOVED; b.ts unchanged. Rescan only a.ts.
  const next = audit.audit(PROJECT, {
    tree: {
      'a.ts': 'export const clean = true;\n',
      'b.ts': "import mixpanel from 'mixpanel-browser';\n",
    },
    priorResult: prior,
    changedFiles: ['a.ts'],
  });
  assert.equal(next.ok, true);
  assert.equal(next.findings.length, 1, 'removed signal in a.ts does not persist');
  assert.equal(next.findings[0].file, 'b.ts', 'unchanged b.ts finding carried forward');
});

test('an incremental re-audit does NOT falsely flag unused-env when the sole reader is an unchanged file', () => {
  const audit = createLockinAudit({ now: stepClock(1) });
  // Prior: a template declares API_KEY, read only by an UNCHANGED reader file.
  // Clean prior (the var IS read), so there is no carried unused-env finding.
  const prior = audit.audit(PROJECT, {
    tree: {
      '.env.template': 'API_KEY=\n',
      'src/reader.ts': 'export const k = process.env.API_KEY;\n',
    },
  });
  assert.equal(prior.ok, true);
  assert.equal(
    prior.findings.filter((f) => f.signal === 'unused-env').length,
    0,
    'prior is clean: API_KEY is read by src/reader.ts',
  );

  // Change ONLY the template (add a comment / whitespace), rescanning just it.
  // src/reader.ts is UNCHANGED and still reads API_KEY. Under the pre-fix bug
  // the cross-file pass saw only the changed template and flagged API_KEY as
  // unused-env; feeding the FULL tree to the cross-file pass keeps it clean.
  const next = audit.audit(PROJECT, {
    tree: {
      '.env.template': '# app config\nAPI_KEY=\n',
      'src/reader.ts': 'export const k = process.env.API_KEY;\n',
    },
    priorResult: prior,
    changedFiles: ['.env.template'],
  });
  assert.equal(next.ok, true);
  assert.equal(
    next.findings.filter((f) => f.signal === 'unused-env').length,
    0,
    'API_KEY is still read by the unchanged src/reader.ts — must NOT be flagged unused',
  );

  // Positive control: the SAME incremental machinery DOES flag a genuinely
  // unread declared var, so the clean result above is not vacuous.
  const orphan = audit.audit(PROJECT, {
    tree: {
      '.env.template': '# app config\nAPI_KEY=\nORPHAN_KEY=\n',
      'src/reader.ts': 'export const k = process.env.API_KEY;\n',
    },
    priorResult: prior,
    changedFiles: ['.env.template'],
  });
  const orphanFindings = orphan.findings.filter((f) => f.signal === 'unused-env');
  assert.equal(orphanFindings.length, 1, 'the genuinely-unread ORPHAN_KEY IS flagged');
  assert.equal(orphanFindings[0].evidence, 'ORPHAN_KEY');
});

test('an incremental re-audit clears a stale unused-env when a CHANGED reader now reads the var (template unchanged)', () => {
  const audit = createLockinAudit({ now: stepClock(1) });
  // Prior: a template declares ORPHAN, read NOWHERE — genuinely unused, flagged.
  const prior = audit.audit(PROJECT, {
    tree: {
      '.env.template': 'ORPHAN=\n',
    },
  });
  assert.equal(prior.ok, true);
  const priorOrphan = prior.findings.filter((f) => f.signal === 'unused-env');
  assert.equal(priorOrphan.length, 1, 'prior: ORPHAN is genuinely unused');
  assert.equal(priorOrphan[0].evidence, 'ORPHAN');
  assert.equal(priorOrphan[0].file, '.env.template');

  // Current: a NEW reader src/r.ts reads process.env.ORPHAN; the template is
  // UNCHANGED. changedFiles names only the reader. Under the pre-fix
  // carry-forward the stale unused-env (on the unchanged template's path) would
  // survive because it is filtered only by the finding's OWN file. The fix
  // recomputes the cross-file signal over the full tree, so ORPHAN is no longer
  // reported unused now that it is read.
  const next = audit.audit(PROJECT, {
    tree: {
      '.env.template': 'ORPHAN=\n',
      'src/r.ts': 'export const k = process.env.ORPHAN;\n',
    },
    priorResult: prior,
    changedFiles: ['src/r.ts'],
  });
  assert.equal(next.ok, true);
  assert.equal(
    next.findings.filter((f) => f.signal === 'unused-env').length,
    0,
    'ORPHAN is now read by the changed src/r.ts — the stale unused-env must NOT carry forward',
  );
});

// --- CLEAN generated template positive control (Req 11.1, Property 15 basis) -

test('every clean generated template reports no findings (detectors are not no-ops)', () => {
  const provider = createTemplateProvider();
  const audit = createLockinAudit({
    now: stepClock(1),
    platformHosts: ['platform.example.dev'],
    vendorPattern: 'aiappbuilder|ai-app-builder',
  });
  for (const category of provider.categories()) {
    const tree = provider.forCategory(category);
    const result = audit.audit(PROJECT, { tree, platformGenerated: true });
    assert.equal(result.ok, true, `${category}: audit ok`);
    assert.equal(
      result.clean,
      true,
      `${category}: clean generated template has NO findings, got ${JSON.stringify(result.findings)}`,
    );
  }
});

// --- false-positive traps from detect-lockin.sh (must NOT be flagged) --------

test('FP trap: a bare `amplitude` physics variable is NOT flagged as telemetry', () => {
  const audit = createLockinAudit({ now: stepClock(1) });
  const result = audit.audit(PROJECT, {
    tree: {
      'wave-motion.ts':
        'export function wave(t) {\n' +
        '  const amplitude = 2.5;\n' +
        '  const frequency = 0.1;\n' +
        '  return amplitude * Math.sin(frequency * t);\n' +
        '}\n',
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.clean, true, 'bare amplitude word must not fire telemetry');
});

test('FP trap: prose about "badges" is NOT flagged as an injected UI component', () => {
  const audit = createLockinAudit({ now: stepClock(1) });
  const result = audit.audit(PROJECT, {
    tree: {
      'achievements.tsx':
        "// You earn a badge for each achievement. Badges show on your profile.\n" +
        "export const label = 'badge';\n" +
        "export const message = 'You unlocked a new badge!';\n",
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.clean, true, 'badge prose must not fire the injected-ui check');
});

test('FP trap: a structural importFrom with NO vendor value is NOT flagged as enforcement', () => {
  const audit = createLockinAudit({ now: stepClock(1), vendorPattern: 'acme' });
  const result = audit.audit(PROJECT, {
    tree: {
      // acme is only in an unrelated comment; the importFrom value is a real dep.
      'structural-rule.json':
        '{\n' +
        '  "//": "acme is our vendor, but this rule does not mandate importing it.",\n' +
        '  "name": "keep-store-adapter-shape",\n' +
        '  "must": { "importFrom": ["@tanstack/react-query"] }\n' +
        '}\n',
    },
  });
  assert.equal(result.ok, true);
  const enf = result.findings.filter((f) => f.signal === 'enforcement');
  assert.equal(enf.length, 0, 'no false enforcement finding when the mandate value is not the vendor');
});

// --- factory shape + frozen ---------------------------------------------------

test('createLockinAudit is a frozen factory with the configured limit + timeout', () => {
  const audit = createLockinAudit({ fileCountLimit: 42, auditTimeoutMs: 7 });
  assert.equal(Object.isFrozen(audit), true);
  assert.equal(audit.fileCountLimit, 42);
  assert.equal(audit.auditTimeoutMs, 7);
  assert.equal(audit.hasSubagentSeam, false);
  assert.equal(typeof audit.audit, 'function');
});
