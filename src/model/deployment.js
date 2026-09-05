/**
 * DeploymentArtifact, ShareLink, and VerifyResult records.
 */

import { Target as Target_Kinds, isValidTarget } from './enums.js';
import {
  requireString,
  requireStringAllowEmpty,
  requireNumber,
  requireBoolean,
  requireEnum,
  requireOneOf,
} from './validate.js';

/** Legal verdicts from plumby verify (Req 20.1). */
export const VERIFY_VERDICTS = Object.freeze(['PASS', 'FAIL']);

/** ShareLink access level — read-only, always (design.md Data Models). */
export const SHARE_LINK_ACCESS = Object.freeze(['read-only']);

/**
 * DeploymentArtifact.
 * Fields: targetKind, path, exitStatus (0 on success, Req 18.1).
 */
export function createDeploymentArtifact(input = {}) {
  const model = 'DeploymentArtifact';
  return {
    targetKind: requireEnum(
      model,
      'targetKind',
      input.targetKind,
      isValidTarget,
      Target_Kinds,
    ),
    path: requireString(model, 'path', input.path),
    exitStatus: requireNumber(model, 'exitStatus', input.exitStatus),
  };
}

/**
 * ShareLink — control-plane only, never exported (Req 26).
 * Fields: token, projectId, access 'read-only', createdAt, expiresAt, revoked.
 */
export function createShareLink(input = {}) {
  const model = 'ShareLink';
  return {
    token: requireString(model, 'token', input.token),
    projectId: requireString(model, 'projectId', input.projectId),
    access: requireOneOf(model, 'access', input.access ?? 'read-only', SHARE_LINK_ACCESS),
    createdAt: requireString(model, 'createdAt', input.createdAt),
    expiresAt: requireString(model, 'expiresAt', input.expiresAt),
    revoked: requireBoolean(model, 'revoked', input.revoked ?? false),
  };
}

/**
 * VerifyResult — from plumby verify (Req 20.1).
 * Fields: verdict, exitCode, failureLines, outputTail.
 */
export function createVerifyResult(input = {}) {
  const model = 'VerifyResult';
  return {
    verdict: requireOneOf(model, 'verdict', input.verdict, VERIFY_VERDICTS),
    exitCode: requireNumber(model, 'exitCode', input.exitCode),
    failureLines: requireStringAllowEmpty(model, 'failureLines', input.failureLines ?? ''),
    outputTail: requireStringAllowEmpty(model, 'outputTail', input.outputTail ?? ''),
  };
}
