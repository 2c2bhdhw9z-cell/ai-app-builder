/**
 * compose.js — the platform-operations COMPOSITION ROOT (spec Task 12, Req 24.4,
 * 25.1, 25.2, 25.3).
 *
 * The FEAT-001 review found that `createRedactor` was only ever assembled in
 * tests: no code path in `src/` built the central redactor from the LIVE secret
 * set and handed it to the AuditLog / Observability / CommandGuard / retention
 * service. Redaction was therefore INERT in any real composition — the only
 * active secret-leak protection was the SecretStore recording NAME-only.
 *
 * This module is that missing production wiring: a small, documented factory
 * that builds ONE central redactor seeded from the live secret VALUES (and
 * NAMES) and returns it alongside a wired AuditLog and Observability, plus
 * ready-made option bundles to hand to createCommandGuard and
 * createRetentionService so every audit / metric / error path routes through the
 * SAME redactor. It composes the existing modules through their EXISTING
 * optional/back-compatible seams — it introduces no new seam and breaks none:
 * every module still works standalone exactly as before when composed by hand.
 *
 * THE SECRET SET: a redactor can only redact values it was constructed with. A
 * SecretStore deliberately never enumerates its VALUES (values leave only via
 * get()/envForProject() for runtime injection), so the composition takes a
 * `secretProvider` — a snapshot/provider of the currently-known secret VALUES
 * and NAMES — as its seed. A deployment builds this from the SecretStore's env
 * map for the live projects (envForProject yields { NAME: value } maps); tests
 * pass an explicit set. Passing a live secret VALUE here is exactly what makes
 * substring redaction of a token embedded in a stderr line an ACTIVE control
 * rather than a no-op.
 */

import { createRedactor } from './redaction.js';
import { createAuditLog } from './audit-log.js';
import { createObservability } from './observability.js';

/**
 * Normalize a `secretProvider` argument into concrete { values, names } arrays.
 *
 * Accepts:
 *   - { secretValues?: Iterable<string>, secretNames?: Iterable<string> }
 *   - a SecretStore-shaped set of { NAME: value } env maps via `envMaps`
 *   - a bare Iterable<string> of secret VALUES
 *   - a function returning any of the above (evaluated once at compose time)
 */
function resolveSecretSet(secretProvider) {
  let provider = secretProvider;
  if (typeof provider === 'function') provider = provider();
  if (provider == null) return { values: [], names: [] };

  // A bare iterable of values (Array/Set/etc. — but not a plain descriptor).
  if (typeof provider[Symbol.iterator] === 'function' && typeof provider !== 'string') {
    return { values: [...provider], names: [] };
  }

  const values = [];
  const names = [];
  if (provider.secretValues) values.push(...provider.secretValues);
  if (provider.secretNames) names.push(...provider.secretNames);

  // `envMaps`: an array of { NAME: value } maps (e.g. secretStore.envForProject
  // outputs). Every value is a secret VALUE and every key a secret NAME.
  if (Array.isArray(provider.envMaps)) {
    for (const map of provider.envMaps) {
      if (map && typeof map === 'object') {
        for (const [name, value] of Object.entries(map)) {
          names.push(name);
          if (typeof value === 'string') values.push(value);
        }
      }
    }
  }

  return { values, names };
}

/**
 * Compose the platform-operations observability spine around ONE central
 * redactor seeded from the live secret set.
 *
 * @param {object} args
 * @param {*} [args.secretProvider]  the live secret set to seed the redactor
 *        (see resolveSecretSet): known secret VALUES + NAMES. Without it the
 *        redactor is empty and redaction is a documented no-op — pass the live
 *        secrets to make redaction an active control.
 * @param {(s:string)=>boolean} [args.isSecretValue]  optional whole-string
 *        secret predicate forwarded to the redactor.
 * @param {() => (number|string)} [args.now]  injectable clock shared by the
 *        AuditLog and Observability.
 * @param {Function|{record:Function}} [args.auditSink]  OPTIONAL downstream sink
 *        the AuditLog forwards each REDACTED entry to (persistent store / second
 *        collector).
 * @param {Function|{record:Function}} [args.metricsSink]  OPTIONAL metrics sink
 *        for Observability.emitMetric.
 * @returns {object} frozen composition:
 *   { redactor, auditLog, observability, commandGuardOptions(),
 *     retentionOptions(), secretStoreOptions() }
 *   — the *Options() helpers return the exact { auditSink, redactor } (and clock)
 *   bundles to spread into createCommandGuard / createRetentionService /
 *   createSecretStore so those choke points record through the SAME wired
 *   AuditLog and redact through the SAME central redactor.
 */
export function composePlatformOps(args = {}) {
  const { secretProvider, isSecretValue, now, auditSink, metricsSink } = args;

  const { values, names } = resolveSecretSet(secretProvider);

  // THE ONE central redactor, seeded from the live secret set. Every wired
  // surface below redacts through THIS instance.
  const redactor = createRedactor({
    secretValues: values,
    secretNames: names,
    isSecretValue,
  });

  // The append-only AuditLog IS a valid audit-sink shape, so it drops into the
  // toAuditSink seam used by every choke point. It routes every entry through
  // the central redactor before appending, and optionally forwards to a further
  // downstream sink.
  const auditLog = createAuditLog({ redactor, now, sink: auditSink });

  // Observability records its operational events/errors on the SAME AuditLog and
  // redacts through the SAME redactor.
  const observability = createObservability({ auditLog, redactor, now, metricsSink });

  /**
   * The bundle to spread into createCommandGuard so CONFIRM_CLASS_OP entries land
   * on the wired AuditLog with the command redacted through the central filter:
   *   createCommandGuard({ manager, ...composed.commandGuardOptions() })
   */
  function commandGuardOptions() {
    return { auditSink: auditLog, redactor };
  }

  /**
   * The bundle to spread into createRetentionService so PROJECT_DELETED /
   * ACCOUNT_DELETED events land on the wired AuditLog, redacted:
   *   createRetentionService({ ...stores, ...composed.retentionOptions() })
   */
  function retentionOptions() {
    return { auditSink: auditLog, redactor };
  }

  /**
   * The bundle to spread into createSecretStore so SECRET_ACCESS events land on
   * the wired AuditLog (name-only; the redactor is a belt-and-braces layer):
   *   createSecretStore({ layout, ...composed.secretStoreOptions() })
   */
  function secretStoreOptions() {
    return { auditSink: auditLog };
  }

  return Object.freeze({
    redactor,
    auditLog,
    observability,
    commandGuardOptions,
    retentionOptions,
    secretStoreOptions,
  });
}
