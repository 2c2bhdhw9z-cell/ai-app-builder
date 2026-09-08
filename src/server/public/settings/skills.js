/*
 * settings/skills.js — the skill-library settings controller (spec Task 14.3;
 * design §"Controllers — settings/*.js", Req 14.1, 14.2).
 *
 * The feature logic behind the skill-library screen:
 *   - list()      → GET the Stocked_Skills + the User_Account's User_Skills
 *                   reported by the backend (Req 14.1).
 *   - addSkill()  → POST a new/imported User_Skill with the Bearer (Req 14.2).
 *   - importSkill() → same POST path, tagged as an import (the backend accepts
 *                   the skill body either way; this just records intent).
 *
 * ─── ASSUMED CONTRACT (honest note) ───────────────────────────────────────
 * The Builder_Server exposes NO skill-library HTTP route today — the skill
 * library is a backend service (src/skills/library.js) that materializes
 * Stocked_Skills from disk and stores User_Skills as SKILL.md dirs, none of it
 * HTTP-surfaced. Per the spec, this controller is written against a DOCUMENTED/
 * ASSUMED contract mirroring those real service shapes and does NOT add or
 * modify any backend route:
 *
 *   GET  /settings/skills                              (Bearer gated)
 *     200 → { stocked: [{ name, description? }...],
 *             user:    [{ name, description? }...] }
 *   POST /settings/skills  body { name, description?, body, import?: true }  (Bearer gated)
 *     200/201 → { skill: { name, description? } }        (the added User_Skill)
 *     400 → { error, code? }                             (naming collision, cap)
 *     401 → (non-disclosing denial; body discarded by api.js)
 *
 * The stocked/user split + the name/description shape mirror
 * src/skills/library.js (loadStockedSkills / readUserSkills → invocationName +
 * description). No skill BODY is read back into the surface list — only the
 * name + description are listed, matching the backend's listing surface.
 *
 * DOM-free and dependency-free: `store` + gated `api` are INJECTED.
 */

import { ACTIONS } from '../store.js';
import { RESULT } from '../api.js';
import { createSettingsState } from './settings-state.js';

/** Client-authored, non-disclosing notice text. */
export const SKILL_MESSAGES = Object.freeze({
  REAUTH: 'Your session expired. Please sign in again.',
  ADDED: 'Skill added.',
  REJECTED: 'That skill could not be added.',
  RATE_LIMITED: 'A usage limit was reached.',
  ERROR: 'The skill could not be added.',
});

/** Normalize a listed skill to the safe { name, description } display shape. */
function normalizeSkill(s) {
  if (!s || typeof s !== 'object') return null;
  const name = typeof s.name === 'string' ? s.name : typeof s.invocationName === 'string' ? s.invocationName : null;
  if (!name) return null;
  return { name, description: typeof s.description === 'string' ? s.description : '' };
}

/**
 * Create the skill-library controller.
 *
 * @param {object} deps
 * @param {{ getState: Function, dispatch: Function }} deps.store
 * @param {{ request: Function }} deps.api
 * @returns {object}
 */
export function createSkillsController({ store, api } = {}) {
  if (!store || typeof store.dispatch !== 'function' || typeof store.getState !== 'function') {
    throw new TypeError('createSkillsController requires a store with getState/dispatch');
  }
  if (!api || typeof api.request !== 'function') {
    throw new TypeError('createSkillsController requires an api client with request()');
  }

  const surface = createSettingsState({
    stocked: [], // [{ name, description }]
    user: [], // [{ name, description }]
    inFlight: false,
  });

  /**
   * List the Stocked_Skills + User_Skills (Req 14.1).
   * @returns {Promise<{ ok: boolean, result?: object }>}
   */
  async function list() {
    const result = await api.request('GET', '/settings/skills');
    if (result.kind === RESULT.OK && result.data && typeof result.data === 'object') {
      const stocked = (Array.isArray(result.data.stocked) ? result.data.stocked : [])
        .map(normalizeSkill)
        .filter(Boolean);
      const user = (Array.isArray(result.data.user) ? result.data.user : [])
        .map(normalizeSkill)
        .filter(Boolean);
      surface.set({ stocked, user });
      return { ok: true, result };
    }
    if (result.kind === RESULT.DENIED) {
      store.dispatch({ type: ACTIONS.NOTICE_SET, kind: 'reauth', message: SKILL_MESSAGES.REAUTH });
    }
    return { ok: false, result };
  }

  /**
   * Add or import a User_Skill (Req 14.2). POSTs the skill with the Bearer; on
   * success appends the returned skill to the user list. `isImport` only tags
   * the request body (`import: true`) so the backend can record provenance.
   *
   * @param {{ name: string, description?: string, body: string }} skill
   * @param {boolean} [isImport=false]
   * @returns {Promise<{ ok: boolean, reason?: string, result?: object }>}
   */
  async function addSkill(skill, isImport = false) {
    surface.set({ inFlight: true });
    const body = {
      name: skill && typeof skill.name === 'string' ? skill.name : '',
      description: skill && typeof skill.description === 'string' ? skill.description : '',
      body: skill && typeof skill.body === 'string' ? skill.body : '',
    };
    if (isImport) body.import = true;
    const result = await api.request('POST', '/settings/skills', { body });

    switch (result.kind) {
      case RESULT.OK: {
        const added = normalizeSkill(result.data && result.data.skill ? result.data.skill : { name: body.name, description: body.description });
        if (added) {
          const user = [...surface.getState().user.filter((s) => s.name !== added.name), added];
          surface.set({ user });
        }
        surface.set({ inFlight: false });
        store.dispatch({ type: ACTIONS.NOTICE_CLEARED });
        return { ok: true, result };
      }
      case RESULT.VALIDATION:
      case RESULT.PROTOCOL:
        surface.set({ inFlight: false });
        store.dispatch({ type: ACTIONS.NOTICE_SET, kind: 'validation', message: SKILL_MESSAGES.REJECTED });
        return { ok: false, reason: 'validation', result };
      case RESULT.RATE_LIMITED: {
        surface.set({ inFlight: false });
        const named = typeof result.limit === 'string' && result.limit ? result.limit : null;
        store.dispatch({ type: ACTIONS.NOTICE_SET, kind: 'rateLimited', message: SKILL_MESSAGES.RATE_LIMITED, limit: named });
        return { ok: false, reason: 'rateLimited', result };
      }
      case RESULT.DENIED:
        surface.set({ inFlight: false });
        store.dispatch({ type: ACTIONS.NOTICE_SET, kind: 'reauth', message: SKILL_MESSAGES.REAUTH });
        return { ok: false, reason: 'denied', result };
      default:
        surface.set({ inFlight: false });
        store.dispatch({ type: ACTIONS.NOTICE_SET, kind: 'error', message: SKILL_MESSAGES.ERROR });
        return { ok: false, reason: 'error', result };
    }
  }

  /** Import a User_Skill (Req 14.2) — the add path tagged as an import. */
  function importSkill(skill) {
    return addSkill(skill, true);
  }

  return {
    getState: surface.getState,
    subscribe: surface.subscribe,
    list,
    addSkill,
    importSkill,
  };
}
