/**
 * MemoryEntry and MemoryStoreMeta records.
 *
 * Memory is human-readable, exportable state (Req 14). MemoryStoreMeta carries
 * the mode + caps with the design's defaults: mode 'auto', capBytes 65536,
 * capEntries 200 (Req 14.3, decision (a)).
 */

import { Memory_Mode, isValidMemoryMode } from './enums.js';
import {
  requireString,
  requireStringAllowEmpty,
  requireNumber,
  requireEnum,
  requireOneOf,
} from './validate.js';

/** Scope of a memory record: per-project or per-account global. */
export const MEMORY_SCOPES = Object.freeze(['project', 'global']);

/** Kinds of a MemoryEntry (design.md Data Models). */
export const MEMORY_ENTRY_KINDS = Object.freeze([
  'decision',
  'preference',
  'convention',
  'correction',
  'summary',
  'user',
]);

/** Origin of a memory entry; in 'off' mode only 'user' is allowed (Property 18). */
export const MEMORY_ORIGINS = Object.freeze(['auto', 'user']);

/** MemoryStoreMeta defaults (design decision (a), Req 14.3). */
export const MEMORY_STORE_DEFAULTS = Object.freeze({
  mode: 'auto',
  capBytes: 65536,
  capEntries: 200,
});

/**
 * MemoryEntry — individually viewable/editable (Req 14.5).
 * Fields: id, scope, kind, text, createdAt, origin.
 */
export function createMemoryEntry(input = {}) {
  const model = 'MemoryEntry';
  return {
    id: requireString(model, 'id', input.id),
    scope: requireOneOf(model, 'scope', input.scope, MEMORY_SCOPES),
    kind: requireOneOf(model, 'kind', input.kind, MEMORY_ENTRY_KINDS),
    text: requireStringAllowEmpty(model, 'text', input.text),
    createdAt: requireString(model, 'createdAt', input.createdAt),
    origin: requireOneOf(model, 'origin', input.origin, MEMORY_ORIGINS),
  };
}

/**
 * MemoryStoreMeta.
 * Fields: scope, mode (default 'auto'), capBytes (default 65536),
 * capEntries (default 200). Unset mode/caps fall back to MEMORY_STORE_DEFAULTS.
 */
export function createMemoryStoreMeta(input = {}) {
  const model = 'MemoryStoreMeta';
  const mode = input.mode ?? MEMORY_STORE_DEFAULTS.mode;
  const capBytes = input.capBytes ?? MEMORY_STORE_DEFAULTS.capBytes;
  const capEntries = input.capEntries ?? MEMORY_STORE_DEFAULTS.capEntries;
  return {
    scope: requireOneOf(model, 'scope', input.scope, MEMORY_SCOPES),
    mode: requireEnum(model, 'mode', mode, isValidMemoryMode, Memory_Mode),
    capBytes: requireNumber(model, 'capBytes', capBytes),
    capEntries: requireNumber(model, 'capEntries', capEntries),
  };
}
