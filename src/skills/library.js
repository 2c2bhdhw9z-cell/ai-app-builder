/**
 * THE SKILL LIBRARY (spec Task 22.3, Req 13.1–13.9).
 *
 * The Skill Library is ai-app-builder's CRUD surface over Skills. It composes
 * three populations, all kept in the ONE open Agent Skills format (a SKILL.md
 * folder with `name` + `description` frontmatter, Req 13.9, Property 19):
 *
 *   - STOCKED_SKILLS (Req 13.1): a small curated set shipped with the platform,
 *     materialized from `src/skills/stocked/<name>/SKILL.md`.
 *   - VENDORED LOCK-IN skills (Req 12): `vendor-lockin-guard` + `devendor-project`
 *     (VENDORED_LOCKIN_SKILLS from vendor.js). These plus the stocked names form
 *     the RESERVED BASE NAMESPACE.
 *   - USER_SKILLS (Req 13.3–13.8): per-User_Account skills a user creates or
 *     imports, stored as SKILL.md dirs under `layout.controlUserSkillsRoot(ownerId)`.
 *
 * NAMESPACING (the decision in design.md §9, Req 13.6–13.7). Invocation names
 * resolve in two namespaces:
 *   - The RESERVED BASE NAMESPACE (stocked + vendored lock-in). A User_Skill can
 *     NEVER overwrite one of these names (Req 13.7) — reserved names always win.
 *   - Each user's own namespace. When a user's requested `name` would collide
 *     with a skill already available to that user (a reserved base-namespace
 *     name, or another of that user's OWN base-level skills), the new skill is
 *     placed under `user/<name>` so it can STILL be added (Req 13.6). Only when
 *     `user/<name>` ALSO already exists for this owner (an intra-user-namespace
 *     duplicate) is the addition rejected with a naming-collision error, leaving
 *     the existing Skill unchanged (Req 13.6).
 * Cross-user reuse of the same name is fine — each user's skills are keyed by
 * ownerId under a separate root.
 *
 * The caps / progressive-disclosure rules (500-char description clip, 16 KiB
 * listing cap, 64 KiB body cap, unknown-name/missing-name/first-wins/outside-tree)
 * are NOT reimplemented here — they live in plumby and are applied at load time
 * by the skill session (FEAT-003). This module only OWNS the CRUD, the on-disk
 * open format, and the namespace resolution. Structured `{ ok:false, code,
 * message }` results and no-partial-state-on-failure follow the repo factory
 * conventions; the plumby boundary (src/engine/plumby.js) stays the only
 * plumby-importing file (we round-trip SKILL.md through parseFrontmatter there).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseFrontmatter } from '../engine/plumby.js';
import { createSkill } from '../model/skill.js';
import { VENDORED_LOCKIN_SKILLS } from './vendor.js';

const MODEL = 'SkillLibrary';

/** The user-namespace prefix (design.md §9, Req 13.6): `user/<name>`. */
export const USER_NAMESPACE_PREFIX = 'user/';

/** Default location of the shipped Stocked_Skills, resolved off this module. */
export const DEFAULT_STOCKED_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'stocked',
);

/**
 * Read the curated Stocked_Skills from `<stockedRoot>/<name>/SKILL.md`. Each is
 * validated through the Skill model (kind 'stocked') so a malformed shipped
 * skill fails loudly at construction rather than silently at session start.
 *
 * @param {string} stockedRoot
 * @returns {Array<object>} Skill records (open format)
 */
export function loadStockedSkills(stockedRoot = DEFAULT_STOCKED_ROOT) {
  let entries;
  try {
    entries = fs.readdirSync(stockedRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const skills = [];
  const seen = new Set();
  const dirNames = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));

  for (const dirName of dirNames) {
    const bodyPath = path.join(stockedRoot, dirName, 'SKILL.md');
    let raw;
    try {
      raw = fs.readFileSync(bodyPath, 'utf8');
    } catch {
      continue;
    }
    const { data, body } = parseFrontmatter(raw);
    const fmName = typeof data.name === 'string' ? data.name.trim() : '';
    const name = fmName !== '' ? fmName : dirName;
    if (seen.has(name)) continue; // first-discovered wins (mirrors plumby)
    seen.add(name);
    const fmDesc = typeof data.description === 'string' ? data.description : '';
    skills.push(
      createSkill({
        name,
        invocationName: name,
        description: fmDesc,
        body,
        kind: 'stocked',
        path: path.join(stockedRoot, dirName),
      }),
    );
  }
  return skills;
}

/**
 * Serialize a Skill into open Agent Skills SKILL.md text: a `---` frontmatter
 * block carrying `name` + `description`, then the body. plumby ships NO
 * serializer, so we emit the text ourselves and it round-trips cleanly through
 * plumby's parseFrontmatter (single-line scalars only — description is
 * collapsed to one line, which the parser reads back verbatim).
 *
 * @param {{name:string, description:string, body:string}} skill
 * @returns {string}
 */
export function serializeSkillMarkdown({ name, description, body }) {
  const oneLineDesc = String(description ?? '').replace(/\s+/g, ' ').trim();
  const lines = ['---', `name: ${name}`, `description: ${oneLineDesc}`, '---', ''];
  const text = String(body ?? '');
  return `${lines.join('\n')}${text.endsWith('\n') || text === '' ? text : `${text}\n`}`;
}

/** Filesystem-safe directory name for a skill dir under an owner's root. */
function dirNameFor(invocationName) {
  // Invocation names are `name` or `user/name`. Map the `/` and any unsafe
  // char to '-' so the dir is a single safe path segment; the invocation name
  // itself is preserved in the SKILL.md frontmatter (that is what plumby's
  // loader reads for the invocation name, not the dir name).
  return invocationName.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'skill';
}

/**
 * Create the Skill Library.
 *
 * @param {object} args
 * @param {object} args.layout  a StorageLayout — supplies controlUserSkillsRoot(ownerId).
 * @param {Iterable<string>} [args.reservedNames]  extra reserved base-namespace
 *   names to merge with the stocked + vendored-lockin names. The full reserved
 *   set is computed at construction so a User_Skill can never overwrite them.
 * @param {string} [args.stockedRoot]  where the shipped Stocked_Skills live.
 * @param {() => Date} [args.now]  injected clock, for structured-result stamps.
 * @returns {object} library (frozen)
 */
export function createSkillLibrary({ layout, reservedNames, stockedRoot = DEFAULT_STOCKED_ROOT, now = () => new Date() } = {}) {
  if (!layout || typeof layout.controlUserSkillsRoot !== 'function') {
    throw new TypeError(`${MODEL}: layout with controlUserSkillsRoot(ownerId) is required`);
  }

  const stocked = loadStockedSkills(stockedRoot);

  // The RESERVED BASE NAMESPACE (Req 13.7): stocked names + the two vendored
  // lock-in names + any extra names the caller reserves. Frozen so a User_Skill
  // can never overwrite them.
  const reserved = new Set([
    ...stocked.map((s) => s.invocationName),
    ...VENDORED_LOCKIN_SKILLS,
    ...(reservedNames ? Array.from(reservedNames) : []),
  ]);

  /** True when `name` is a reserved base-namespace invocation name. */
  function isReserved(name) {
    return reserved.has(name);
  }

  /** Absolute root for an owner's User_Skills (out-of-tree, per-account). */
  function rootFor(ownerId) {
    return layout.controlUserSkillsRoot(ownerId);
  }

  /**
   * Read an owner's User_Skills off disk as open-format records. A missing root
   * is a no-op ([]). Each record's invocationName comes from its frontmatter
   * `name` (falling back to the dir name), exactly as plumby's loader resolves
   * it, so what this returns matches what a session would discover.
   *
   * @param {string} ownerId
   * @returns {Array<object>} Skill records
   */
  function readUserSkills(ownerId) {
    const root = rootFor(ownerId);
    let entries;
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      return [];
    }
    const skills = [];
    const seen = new Set();
    const dirNames = entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b));
    for (const dirName of dirNames) {
      const dir = path.join(root, dirName);
      const bodyPath = path.join(dir, 'SKILL.md');
      let raw;
      try {
        raw = fs.readFileSync(bodyPath, 'utf8');
      } catch {
        continue;
      }
      const { data, body } = parseFrontmatter(raw);
      const fmName = typeof data.name === 'string' ? data.name.trim() : '';
      const invocationName = fmName !== '' ? fmName : dirName;
      if (seen.has(invocationName)) continue; // first-wins on duplicate
      seen.add(invocationName);
      const description = typeof data.description === 'string' ? data.description : '';
      skills.push(
        createSkill({
          name: invocationName.startsWith(USER_NAMESPACE_PREFIX)
            ? invocationName.slice(USER_NAMESPACE_PREFIX.length)
            : invocationName,
          invocationName,
          description,
          body,
          kind: 'user',
          ownerId,
          path: dir,
        }),
      );
    }
    return skills;
  }

  /**
   * Resolve the invocation name for a NEW User_Skill (Req 13.6, 13.7). Returns
   * either { ok:true, invocationName } or a structured rejection.
   *
   * Rule:
   *   (a) if `requestedName` is reserved (base namespace) OR collides with a
   *       skill already available to this user (a reserved name, or one of the
   *       user's OWN base-level names), namespace it as `user/<requestedName>`
   *       so it can still be added;
   *   (b) if that `user/<requestedName>` already exists for THIS owner, REJECT
   *       (intra-user-namespace duplicate) — leave the existing skill unchanged;
   *   (c) otherwise the base-level `requestedName` is free for this user.
   */
  function resolveInvocationName(ownerId, requestedName) {
    const userSkills = readUserSkills(ownerId);
    const userInvocationNames = new Set(userSkills.map((s) => s.invocationName));

    const collides =
      isReserved(requestedName) || userInvocationNames.has(requestedName);

    if (!collides) {
      return { ok: true, invocationName: requestedName };
    }

    const namespaced = `${USER_NAMESPACE_PREFIX}${requestedName}`;
    if (userInvocationNames.has(namespaced)) {
      return {
        ok: false,
        code: 'naming_collision',
        message: `${MODEL}: a skill named ${JSON.stringify(namespaced)} already exists in your namespace; the existing Skill is unchanged`,
      };
    }
    return { ok: true, invocationName: namespaced };
  }

  /**
   * Write a User_Skill to disk in open format and return its record. Assumes the
   * invocation name has already been resolved (and its dir is free). Writes
   * atomically via a temp file + rename so a failed write leaves no partial dir.
   */
  function writeUserSkill(ownerId, { requestedName, invocationName, description, body }) {
    // Validate through the real Skill model FIRST (kind 'user' requires ownerId),
    // so nothing touches disk when the record is invalid (no partial state).
    let record;
    try {
      record = createSkill({
        name: requestedName,
        invocationName,
        description,
        body,
        kind: 'user',
        ownerId,
        path: 'pending',
      });
    } catch (err) {
      return { ok: false, code: 'invalid_skill', message: `${MODEL}: ${err.message}` };
    }

    const root = rootFor(ownerId);
    const dir = path.join(root, dirNameFor(invocationName));
    const bodyPath = path.join(dir, 'SKILL.md');
    const markdown = serializeSkillMarkdown({ name: invocationName, description: record.description, body: record.body });

    try {
      fs.mkdirSync(dir, { recursive: true });
      const tmp = `${bodyPath}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
      const fd = fs.openSync(tmp, 'w');
      try {
        fs.writeSync(fd, Buffer.from(markdown, 'utf8'));
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmp, bodyPath);
    } catch (err) {
      return { ok: false, code: 'write_failed', message: `${MODEL}: could not write skill: ${err.message}` };
    }

    return { ok: true, skill: { ...record, path: dir }, at: now().toISOString() };
  }

  /**
   * createUserSkill (Req 13.3): add a User_Skill from name + description + body.
   * Applies the namespacing rule, then writes the open-format SKILL.md.
   */
  function createUserSkill({ ownerId, name, description, body } = {}) {
    if (typeof ownerId !== 'string' || ownerId.trim() === '') {
      return { ok: false, code: 'invalid_owner', message: `${MODEL}: ownerId must be a non-empty string` };
    }
    if (typeof name !== 'string' || name.trim() === '') {
      return { ok: false, code: 'missing_name', message: `${MODEL}: a User_Skill requires a name` };
    }
    if (typeof description !== 'string' || description.trim() === '') {
      return { ok: false, code: 'missing_description', message: `${MODEL}: a User_Skill requires a description` };
    }
    const requestedName = name.trim();
    const resolved = resolveInvocationName(ownerId, requestedName);
    if (!resolved.ok) return resolved;
    return writeUserSkill(ownerId, {
      requestedName,
      invocationName: resolved.invocationName,
      description,
      body: typeof body === 'string' ? body : '',
    });
  }

  /**
   * importSkill (Req 13.4, 13.5): add a Skill given either raw open-format
   * SKILL.md text (`skillMarkdown`) or a structured `{ name, description, body }`.
   * VALIDATES that `name` AND `description` are present; a missing/invalid field
   * REJECTS with an error NAMING the field and adds NOTHING. On success applies
   * the same namespacing rule as createUserSkill.
   */
  function importSkill({ ownerId, skillMarkdown, name, description, body } = {}) {
    if (typeof ownerId !== 'string' || ownerId.trim() === '') {
      return { ok: false, code: 'invalid_owner', message: `${MODEL}: ownerId must be a non-empty string` };
    }

    let importName = name;
    let importDesc = description;
    let importBody = body;

    if (typeof skillMarkdown === 'string') {
      // Parse raw SKILL.md through the plumby boundary; open-format validation
      // is exactly "does it carry name + description in frontmatter".
      const parsed = parseFrontmatter(skillMarkdown);
      importName = typeof parsed.data.name === 'string' ? parsed.data.name : undefined;
      importDesc = typeof parsed.data.description === 'string' ? parsed.data.description : undefined;
      importBody = parsed.body;
    } else if (name === undefined && description === undefined && body === undefined) {
      return {
        ok: false,
        code: 'invalid_format',
        message: `${MODEL}: import rejected: expected open-format SKILL.md text or a { name, description, body } object`,
      };
    }

    if (typeof importName !== 'string' || importName.trim() === '') {
      return {
        ok: false,
        code: 'missing_name',
        message: `${MODEL}: import rejected: missing required field "name"`,
      };
    }
    if (typeof importDesc !== 'string' || importDesc.trim() === '') {
      return {
        ok: false,
        code: 'missing_description',
        message: `${MODEL}: import rejected: missing required field "description"`,
      };
    }

    const requestedName = importName.trim();
    const resolved = resolveInvocationName(ownerId, requestedName);
    if (!resolved.ok) return resolved;
    return writeUserSkill(ownerId, {
      requestedName,
      invocationName: resolved.invocationName,
      description: importDesc,
      body: typeof importBody === 'string' ? importBody : '',
    });
  }

  /** Find one of an owner's User_Skills by its resolved invocation name. */
  function findUserSkill(ownerId, invocationName) {
    return readUserSkills(ownerId).find((s) => s.invocationName === invocationName);
  }

  /**
   * editUserSkill (Req 13.8): update the description and/or body of the owner's
   * own User_Skill. Rejects editing a reserved base-namespace skill (Stocked or
   * vendored lock-in are in a different, reserved root and are left untouched).
   */
  function editUserSkill({ ownerId, invocationName, description, body } = {}) {
    if (typeof ownerId !== 'string' || ownerId.trim() === '') {
      return { ok: false, code: 'invalid_owner', message: `${MODEL}: ownerId must be a non-empty string` };
    }
    if (typeof invocationName !== 'string' || invocationName.trim() === '') {
      return { ok: false, code: 'missing_name', message: `${MODEL}: invocationName is required` };
    }
    if (isReserved(invocationName)) {
      return {
        ok: false,
        code: 'reserved_skill',
        message: `${MODEL}: ${JSON.stringify(invocationName)} is a reserved base-namespace skill and cannot be edited`,
      };
    }
    const existing = findUserSkill(ownerId, invocationName);
    if (!existing) {
      return { ok: false, code: 'not_found', message: `${MODEL}: no User_Skill named ${JSON.stringify(invocationName)} for this owner` };
    }
    if (description !== undefined && (typeof description !== 'string' || description.trim() === '')) {
      return { ok: false, code: 'missing_description', message: `${MODEL}: description, when edited, must be a non-empty string` };
    }
    if (body !== undefined && typeof body !== 'string') {
      return { ok: false, code: 'invalid_body', message: `${MODEL}: body, when edited, must be a string` };
    }

    const nextDesc = description !== undefined ? description : existing.description;
    const nextBody = body !== undefined ? body : existing.body;

    // Reuse the atomic writer; the dir already exists and the invocation name is
    // unchanged, so this rewrites the SKILL.md in place.
    const written = writeUserSkill(ownerId, {
      requestedName: existing.name,
      invocationName,
      description: nextDesc,
      body: nextBody,
    });
    if (!written.ok) return written;
    return { ok: true, skill: written.skill, at: written.at };
  }

  /**
   * deleteUserSkill (Req 13.8): remove ONLY the owner's own User_Skill. Rejects
   * deleting a reserved base-namespace skill; Stocked/vendored skills live in a
   * different root and are never touched.
   */
  function deleteUserSkill({ ownerId, invocationName } = {}) {
    if (typeof ownerId !== 'string' || ownerId.trim() === '') {
      return { ok: false, code: 'invalid_owner', message: `${MODEL}: ownerId must be a non-empty string` };
    }
    if (typeof invocationName !== 'string' || invocationName.trim() === '') {
      return { ok: false, code: 'missing_name', message: `${MODEL}: invocationName is required` };
    }
    if (isReserved(invocationName)) {
      return {
        ok: false,
        code: 'reserved_skill',
        message: `${MODEL}: ${JSON.stringify(invocationName)} is a reserved base-namespace skill and cannot be deleted`,
      };
    }
    const existing = findUserSkill(ownerId, invocationName);
    if (!existing) {
      return { ok: false, code: 'not_found', message: `${MODEL}: no User_Skill named ${JSON.stringify(invocationName)} for this owner` };
    }
    try {
      fs.rmSync(existing.path, { recursive: true, force: true });
    } catch (err) {
      return { ok: false, code: 'delete_failed', message: `${MODEL}: could not delete skill: ${err.message}` };
    }
    return { ok: true, deleted: invocationName, at: now().toISOString() };
  }

  /**
   * deleteAccountData(ownerId): the RetentionService seam (src/ops/retention.js).
   * Removes the owner's ENTIRE User_Skills root, leaving Stocked/vendored skills
   * (in the reserved root) intact. Idempotent.
   */
  function deleteAccountData(ownerId) {
    if (typeof ownerId !== 'string' || ownerId.trim() === '') {
      return { ok: false, code: 'invalid_owner', message: `${MODEL}: ownerId must be a non-empty string` };
    }
    const root = rootFor(ownerId);
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch (err) {
      return { ok: false, code: 'delete_failed', message: `${MODEL}: could not delete user skills: ${err.message}` };
    }
    return { ok: true, deleted: 'Skills', ownerId, at: now().toISOString() };
  }

  /**
   * list(ownerId): the Skills available to the user — the reserved base-namespace
   * skills (stocked + vendored lock-in, the latter discovered by the session,
   * not stored here) plus the owner's User_Skills — each in open format with its
   * resolved invocationName. Vendored lock-in skills are surfaced by the skill
   * SESSION (FEAT-003) from the `.plumby/skills` tree, so `list` returns the
   * stocked base skills this library owns plus the owner's User_Skills; both
   * populations stay loadable by plumby's loader (Req 13.9, Property 19).
   */
  function list(ownerId) {
    const base = stocked.map((s) => ({ ...s }));
    if (typeof ownerId !== 'string' || ownerId.trim() === '') {
      return base;
    }
    return [...base, ...readUserSkills(ownerId)];
  }

  return Object.freeze({
    reservedNames: Object.freeze([...reserved].sort((a, b) => a.localeCompare(b))),
    isReserved,
    stockedSkills: () => stocked.map((s) => ({ ...s })),
    readUserSkills,
    resolveInvocationName,
    createUserSkill,
    importSkill,
    editUserSkill,
    deleteUserSkill,
    deleteAccountData,
    list,
  });
}
