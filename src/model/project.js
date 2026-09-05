/**
 * Project, Target, and Snapshot records.
 *
 * A Project is the top-level unit a User_Account owns (Req 7.3). Its enum
 * fields reuse the frozen enums + predicates from enums.js so the legal value
 * sets live in exactly one place.
 */

import {
  Target_Category,
  Project_Origin,
  Target as Target_Kinds,
  isValidTargetCategory,
  isValidProjectOrigin,
  isValidTarget,
} from './enums.js';
import {
  requireString,
  optionalString,
  requireArray,
  requireEnum,
  requireOneOf,
} from './validate.js';

/** Builder model providers a Project can be configured with (Req 21). */
export const PROJECT_PROVIDERS = Object.freeze(['anthropic', 'gemini', 'openrouter']);

/** How a Snapshot came to exist (design decision (b)). */
export const SNAPSHOT_TRIGGERS = Object.freeze(['turn-pass', 'explicit']);

/**
 * Target — a concrete build target within a Project (Req 16.8).
 * Fields: kind, rootPath, devServer?, lastArtifact?.
 */
export function createTarget(input = {}) {
  const model = 'Target';
  const target = {
    kind: requireEnum(model, 'kind', input.kind, isValidTarget, Target_Kinds),
    rootPath: requireString(model, 'rootPath', input.rootPath),
  };
  if (input.devServer !== undefined) target.devServer = input.devServer;
  if (input.lastArtifact !== undefined) target.lastArtifact = input.lastArtifact;
  return target;
}

/**
 * Project (Req 1, 5, 7, 8, 10, 16, 19, 21).
 * Fields: id, ownerId, description, targetCategory, origin, originRef?, targets,
 * sandboxId, snapshots, connectors, provider, model, createdAt, updatedAt.
 */
export function createProject(input = {}) {
  const model = 'Project';
  return {
    id: requireString(model, 'id', input.id),
    ownerId: requireString(model, 'ownerId', input.ownerId),
    description: requireString(model, 'description', input.description),
    targetCategory: requireEnum(
      model,
      'targetCategory',
      input.targetCategory,
      isValidTargetCategory,
      Target_Category,
    ),
    origin: requireEnum(
      model,
      'origin',
      input.origin,
      isValidProjectOrigin,
      Project_Origin,
    ),
    originRef: optionalString(model, 'originRef', input.originRef),
    targets: requireArray(model, 'targets', input.targets),
    sandboxId: requireString(model, 'sandboxId', input.sandboxId),
    snapshots: requireArray(model, 'snapshots', input.snapshots ?? []),
    connectors: requireArray(model, 'connectors', input.connectors ?? []),
    provider: requireOneOf(model, 'provider', input.provider, PROJECT_PROVIDERS),
    model: requireString(model, 'model', input.model),
    createdAt: requireString(model, 'createdAt', input.createdAt),
    updatedAt: requireString(model, 'updatedAt', input.updatedAt),
  };
}

/**
 * Snapshot — atomic, restorable full file state (Req 19.3).
 * Fields: id, projectId, parentId?, createdAt, trigger.
 */
export function createSnapshot(input = {}) {
  const model = 'Snapshot';
  return {
    id: requireString(model, 'id', input.id),
    projectId: requireString(model, 'projectId', input.projectId),
    parentId: optionalString(model, 'parentId', input.parentId),
    createdAt: requireString(model, 'createdAt', input.createdAt),
    trigger: requireOneOf(model, 'trigger', input.trigger, SNAPSHOT_TRIGGERS),
  };
}
