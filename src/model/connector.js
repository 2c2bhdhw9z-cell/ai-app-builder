/**
 * Connector, ConnectorBinding, and Secret records.
 *
 * CRITICAL storage-split invariant (Req 9.7, 10.4, 24.3, Properties 8, 9, 14):
 *   - A ConnectorBinding holds secret NAMES only (secretRefs), never values.
 *   - A Secret carries ciphertext + wrappedDataKey and NEVER a plaintext value
 *     field. Secret values live out-of-tree (see src/storage/) so they can
 *     never leak into an exported project tree.
 */

import { Connector_Category, isValidConnectorCategory } from './enums.js';
import {
  requireString,
  requireArray,
  requireEnum,
  requireOneOf,
  fail,
} from './validate.js';

/** How a connector captures credentials (design.md Data Models). */
export const CONNECTOR_CAPTURE_KINDS = Object.freeze(['oauth', 'api-key']);

/** Lifecycle status of a ConnectorBinding. */
export const CONNECTOR_BINDING_STATUS = Object.freeze(['active', 'removed']);

/**
 * Connector — an external service integration owned by a User_Account (Req 7.3,
 * 10.1). Fields: service, category, captureKind.
 */
export function createConnector(input = {}) {
  const model = 'Connector';
  return {
    service: requireString(model, 'service', input.service),
    category: requireEnum(
      model,
      'category',
      input.category,
      isValidConnectorCategory,
      Connector_Category,
    ),
    captureKind: requireOneOf(
      model,
      'captureKind',
      input.captureKind,
      CONNECTOR_CAPTURE_KINDS,
    ),
  };
}

/**
 * ConnectorBinding — a Connector attached to a Project (Req 10).
 * Fields: connector, secretRefs (NAMES only), status.
 *
 * secretRefs must be an array of non-empty strings and nothing else — this is
 * the enforcement point that keeps secret VALUES out of control-plane records.
 */
export function createConnectorBinding(input = {}) {
  const model = 'ConnectorBinding';
  const connector = createConnector(input.connector ?? {});
  const secretRefs = requireArray(model, 'secretRefs', input.secretRefs ?? []);
  for (const [i, ref] of secretRefs.entries()) {
    if (typeof ref !== 'string' || ref.trim() === '') {
      fail(model, `secretRefs[${i}] must be a non-empty string (a secret NAME, not a value)`);
    }
  }
  return {
    connector,
    secretRefs: [...secretRefs],
    status: requireOneOf(model, 'status', input.status, CONNECTOR_BINDING_STATUS),
  };
}

/**
 * Secret — NEVER written to source or export (Properties 8, 9, 14; Req 24.3).
 * Fields: projectId, name, ciphertext, wrappedDataKey.
 *
 * There is deliberately NO `value` field. A caller passing a plaintext `value`
 * is rejected, so plaintext can never be persisted through this factory.
 */
export function createSecret(input = {}) {
  const model = 'Secret';
  if ('value' in input) {
    fail(
      model,
      'a Secret must never carry a plaintext `value` field; store ciphertext + wrappedDataKey only',
    );
  }
  return {
    projectId: requireString(model, 'projectId', input.projectId),
    name: requireString(model, 'name', input.name),
    ciphertext: requireCiphertext(model, 'ciphertext', input.ciphertext),
    wrappedDataKey: requireCiphertext(model, 'wrappedDataKey', input.wrappedDataKey),
  };
}

/**
 * Ciphertext bytes: accept a Uint8Array/Buffer or a (base64-ish) string, since
 * real envelope encryption is a later task (12.4). Reject empty/plaintext-shaped
 * nulls so the field is always present and opaque.
 */
function requireCiphertext(model, field, value) {
  if (value instanceof Uint8Array) {
    if (value.length === 0) fail(model, `${field} must be non-empty bytes`);
    return value;
  }
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }
  fail(model, `${field} must be non-empty ciphertext bytes (Uint8Array) or an encoded string`);
}
