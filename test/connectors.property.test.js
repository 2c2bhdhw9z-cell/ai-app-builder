/**
 * Property 9: Connector credential non-leakage (spec Task 21.2, Req 10.4, 11.4).
 *
 * The property under test, greppable verbatim for the spec map:
 *   Feature: ai-app-builder, Property 9: Connector credential non-leakage
 *
 * For ALL Connectors added to a Project, no generated source file COMMITTED to a
 * Snapshot contains the literal credential VALUE. This mirrors the Property 8
 * (Secret non-leakage) test in test/secrets.test.js, but drives the whole thing
 * through the REAL Connector path and commits to a REAL Snapshot (a real Git
 * commit inside the project's exportable tree):
 *
 *   1. A REAL StorageLayout on an fs.mkdtemp temp dir, a REAL SecretStore, a REAL
 *      ConnectorBindingStore, a REAL ConnectorsSteeringWriter, and the REAL
 *      createConnectorService compose the subsystem. The ONLY fake is the
 *      external OAuth/API-key capture boundary seam, and it returns a REAL
 *      success contract carrying the fast-check-generated credential value.
 *   2. addConnector stores that credential as a Secret (value OUT-OF-TREE),
 *      persists an active binding, and writes the steering manifest — all REAL
 *      side effects.
 *   3. Representative generated source ADVERSARIALLY embeds the literal
 *      credential value; the REAL generation-guardrail (scanAndSubstitute) is the
 *      secondary net that rewrites the literal into a `process.env.NAME`
 *      reference before the tree is written.
 *   4. The guarded tree is COMMITTED to a REAL Snapshot via
 *      createSnapshotStore(...).commitSnapshot(projectId, tree, {trigger:'explicit'}).
 *   5. We GREP the COMMITTED working tree (which now contains the .git repo and
 *      the working files git checked out) and assert the literal credential value
 *      appears in NO committed source file, AND that secretStore.get round-trips
 *      the value (it genuinely exists out-of-tree, so this is not vacuously true).
 *
 * >=100 iterations (fcConfig.numRuns).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import fc from 'fast-check';

import { fcConfig, propertyTag } from './support/fc.js';
import { createStorageLayout } from '../src/storage/layout.js';
import { createSecretStore } from '../src/secrets/secret-store.js';
import { scanAndSubstitute } from '../src/secrets/index.js';
import { createSnapshotStore } from '../src/persistence/snapshot-store.js';
import {
  createConnectorService,
  createConnectorBindingStore,
  createConnectorsSteeringWriter,
  defaultConnectorCatalog,
} from '../src/connectors/index.js';

const OWNER = 'owner-prop9';
const PROJECT = 'proj-prop9';

// Feature: ai-app-builder, Property 9: Connector credential non-leakage
test(propertyTag(9, 'Connector credential non-leakage'), async () => {
  // A credential-shaped generator: a distinctive, unguessable prefix (`ck_live_`)
  // plus a varied body incl. quotes and backslashes that could break naive
  // escaping. The prefix guarantees the value is a genuine credential rather than
  // a 1-char coincidence in code boilerplate — the property is that a real
  // credential VALUE never survives into a committed file. minLength>=1.
  const credentialGen = fc
    .string({
      minLength: 1,
      maxLength: 60,
      unit: fc.constantFrom(...'ABCDEFabcdef0123456789-_./:@!#$%^&*()"\\'.split('')),
    })
    .map((body) => `ck_live_${body}`);

  await fc.assert(
    fc.asyncProperty(credentialGen, async (credential) => {
      const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'aab-prop9-'));
      try {
        // --- REAL collaborators (only the capture boundary is faked) --------
        const layout = createStorageLayout(base);
        const secretStore = createSecretStore({ layout, ownerId: OWNER });
        const bindingStore = createConnectorBindingStore({ layout, ownerId: OWNER });
        const steeringWriter = createConnectorsSteeringWriter({ layout });
        const snapshotStore = createSnapshotStore({ layout, ownerId: OWNER });

        // The connector under test: stripe (single env NAME, api-key). Its NAME
        // is what generated code must reference; its VALUE is the generated
        // credential that must never survive into a committed file.
        const service = 'stripe';
        const [envName] = defaultConnectorCatalog.get(service).envNames;

        // The fake external capture boundary returns a REAL success contract
        // carrying the generated credential value for the catalog's env NAME.
        const capture = ({ envNames }) =>
          Object.freeze({
            ok: true,
            credentials: Object.freeze(Object.fromEntries(envNames.map((n) => [n, credential]))),
          });

        const service_ = createConnectorService({
          secretStore,
          bindingStore,
          steeringWriter,
          capture,
          catalog: defaultConnectorCatalog,
        });

        // --- add the Connector (real side effects) --------------------------
        const added = await service_.addConnector({ projectId: PROJECT, service });
        assert.equal(added.ok, true, 'connector must be added');
        assert.ok(added.secretRefs.includes(envName));

        // The VALUE genuinely lives out-of-tree in the SecretStore.
        assert.equal(secretStore.get(PROJECT, envName), credential);

        // --- generate representative source that adversarially embeds the ----
        //     literal credential, then run it through the REAL guardrail -------
        const generated = {
          'src/pay.js':
            `const key = "${credential}";\n` +
            `export function client() { return process.env.${envName}; }\n`,
          'src/config.js': `export const cfg = { secret: "${credential}" };\n`,
          'README.md': `Configure ${envName}. Do not hardcode the value ${credential} here.\n`,
        };
        const { files } = scanAndSubstitute({
          files: generated,
          secrets: { [envName]: credential },
          platformHosts: [],
        });

        // --- COMMIT the guarded tree to a REAL Snapshot (real Git commit) ----
        const commit = snapshotStore.commitSnapshot(PROJECT, files, { trigger: 'explicit' });
        assert.equal(commit.ok, true, `snapshot commit must succeed: ${JSON.stringify(commit.error)}`);
        assert.ok(commit.snapshotId, 'a snapshot id (commit sha) is produced');

        // --- GREP the entire committed tree: value must appear in NO file ----
        const tree = layout.exportableProjectTree(PROJECT);
        const walk = (dir) => {
          for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
            if (ent.name === '.git') continue; // skip the git object store internals
            const full = path.join(dir, ent.name);
            if (ent.isDirectory()) walk(full);
            else {
              const body = fs.readFileSync(full, 'utf8');
              assert.ok(
                !body.includes(credential),
                `committed file ${full} leaked the credential value`,
              );
            }
          }
        };
        walk(tree);

        // The committed working tree IS the commit content (commitSnapshot
        // materializes exactly the passed tree, `git add -A` + commit, and the
        // working files git tracks are byte-for-byte the committed blobs), so the
        // walk above scans the COMMITTED source. The .git internal object store is
        // skipped deliberately — it holds compressed/packed objects, and the
        // property is about generated SOURCE files, not git's internal encoding.

        // --- the store round-trips the value (not vacuously true) -----------
        assert.equal(secretStore.get(PROJECT, envName), credential);
        // And the out-of-tree secret path is NOT inside the export tree.
        assert.equal(
          layout.isInsideExportTree(layout.controlSecretPath(OWNER, PROJECT, envName)),
          false,
        );
      } finally {
        await fsp.rm(base, { recursive: true, force: true });
      }
    }),
    fcConfig,
  );
});
