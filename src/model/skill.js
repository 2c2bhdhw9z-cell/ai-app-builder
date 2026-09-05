/**
 * Skill record — open Agent Skills format (Property 19).
 *
 * Fields: name, invocationName, description, body, kind, ownerId?, path.
 * User skills (kind 'user') are owned by a User_Account (Req 7.3) and carry an
 * ownerId; stocked/vendored-lockin skills do not.
 */

import {
  requireString,
  requireStringAllowEmpty,
  optionalString,
  requireOneOf,
  fail,
} from './validate.js';

/** Legal skill kinds (design.md Data Models). */
export const SKILL_KINDS = Object.freeze(['stocked', 'vendored-lockin', 'user']);

/**
 * Skill (Req 12, 13).
 * A 'user' skill requires an ownerId (its User_Skill namespace, Req 13.6);
 * base-namespace kinds ('stocked' | 'vendored-lockin') must not carry one.
 */
export function createSkill(input = {}) {
  const model = 'Skill';
  const kind = requireOneOf(model, 'kind', input.kind, SKILL_KINDS);
  const ownerId = optionalString(model, 'ownerId', input.ownerId);
  if (kind === 'user' && !ownerId) {
    fail(model, "a 'user' skill requires an ownerId (its User_Skill namespace)");
  }
  if (kind !== 'user' && ownerId) {
    fail(model, `a '${kind}' skill (base namespace) must not carry an ownerId`);
  }
  return {
    name: requireString(model, 'name', input.name),
    invocationName: requireString(model, 'invocationName', input.invocationName),
    description: requireStringAllowEmpty(model, 'description', input.description),
    body: requireStringAllowEmpty(model, 'body', input.body),
    kind,
    ...(ownerId ? { ownerId } : {}),
    path: requireString(model, 'path', input.path),
  };
}
