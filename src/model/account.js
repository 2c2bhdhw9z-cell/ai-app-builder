/**
 * Identity + authorization records.
 *
 * User_Account is the authenticated identity that owns all user resources
 * (Req 7). Authorization is the per-resource access decision that every
 * authorization check resolves against (Req 7.4, 7.5).
 */

import { requireString, requireOneOf } from './validate.js';

/** Legal resource types an Authorization can target (design.md Data Models). */
export const AUTHZ_RESOURCE_TYPES = Object.freeze([
  'project',
  'user-skill',
  'global-memory',
  'connector',
  'secret',
  'share-link',
]);

/** Legal relations of a requester to a resource. 'none' ⇒ access denied. */
export const AUTHZ_RELATIONS = Object.freeze(['owner', 'granted', 'none']);

/**
 * User_Account — authenticated identity; owns all user resources (Req 7).
 * Fields: id, authIdentity, createdAt.
 */
export function createUserAccount(input = {}) {
  const model = 'User_Account';
  return {
    id: requireString(model, 'id', input.id),
    authIdentity: requireString(model, 'authIdentity', input.authIdentity),
    createdAt: requireString(model, 'createdAt', input.createdAt),
  };
}

/**
 * Authorization — per-resource access decision (Req 7.4).
 * Fields: userAccountId, resourceType, resourceId, relation.
 */
export function createAuthorization(input = {}) {
  const model = 'Authorization';
  return {
    userAccountId: requireString(model, 'userAccountId', input.userAccountId),
    resourceType: requireOneOf(
      model,
      'resourceType',
      input.resourceType,
      AUTHZ_RESOURCE_TYPES,
    ),
    resourceId: requireString(model, 'resourceId', input.resourceId),
    relation: requireOneOf(model, 'relation', input.relation, AUTHZ_RELATIONS),
  };
}
