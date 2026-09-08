/*
 * views/settings/settings-panel.js — the settings surfaces view (spec Tasks
 * 14.1–14.4 / 15.1; design §"Views — views/settings/*", Req 12–15, 11.3).
 *
 * ONE cohesive settings panel that renders all five settings surfaces as
 * sections over their respective controllers (settings/provider.js,
 * settings/connectors.js, settings/skills.js, settings/memory.js,
 * settings/lifecycle.js):
 *
 *   - PROVIDER   — a list of available providers with the active one marked, and
 *     a select+apply to switch it (Req 12.1–12.4).
 *   - CONNECTORS — the Connector_Catalog grouped by category, a secret-entry +
 *     configure control per connector, and each connector's bound state. The
 *     secret input is write-only: it is cleared on submit and the stored secret
 *     is NEVER rendered back (Req 13.1–13.4).
 *   - SKILLS     — the Stocked_Skills + User_Skills lists and an add/import
 *     control (Req 14.1, 14.2).
 *   - MEMORY     — the Project_Memory + Global_Memory entries, the active
 *     Memory_Mode, edit/prune controls, and a mode switch (Req 14.3–14.5).
 *   - LIFECYCLE  — build / deploy / export(download) / lock-in-audit / share
 *     controls and their displayed outcomes (Req 15.1–15.6).
 *
 * Each section subscribes to its controller's own observable surface state and
 * to the shared store's session.notice (for the non-disclosing re-auth/error
 * line). The panel is shown/hidden by the router in app.js; this view only
 * builds nodes and forwards intent.
 *
 * CSP hygiene (Req 1.4): every node is built with the DOM API — NO innerHTML, NO
 * inline handlers, NO inline <style>, NO external origin. Colors come from the
 * palette-driven `--color-*` custom properties via styles.css. Controls that a
 * user taps (buttons, selects, inputs) are touch-sized via the .settings__*
 * classes (min-height: var(--touch)) (Req 11.3).
 */

import { MEMORY_MODES } from '../../settings/memory.js';

/** Stable DOM ids/classes so the panel is greppable, styleable, and testable. */
export const SETTINGS_DOM = Object.freeze({
  rootClass: 'settings',
  notice: 'settings-notice',
  // provider
  providerSection: 'settings-provider',
  providerSelect: 'settings-provider-select',
  providerApply: 'settings-provider-apply',
  providerActive: 'settings-provider-active',
  // connectors
  connectorsSection: 'settings-connectors',
  connectorSecretPrefix: 'settings-connector-secret-', // + service
  connectorConfigurePrefix: 'settings-connector-configure-', // + service
  connectorBoundPrefix: 'settings-connector-bound-', // + service
  // skills
  skillsSection: 'settings-skills',
  skillsStocked: 'settings-skills-stocked',
  skillsUser: 'settings-skills-user',
  skillName: 'settings-skill-name',
  skillBody: 'settings-skill-body',
  skillAdd: 'settings-skill-add',
  skillImport: 'settings-skill-import',
  // memory
  memorySection: 'settings-memory',
  memoryProject: 'settings-memory-project',
  memoryGlobal: 'settings-memory-global',
  memoryMode: 'settings-memory-mode',
  // lifecycle
  lifecycleSection: 'settings-lifecycle',
  build: 'settings-build',
  deploy: 'settings-deploy',
  export: 'settings-export',
  audit: 'settings-audit',
  share: 'settings-share',
  shareUrl: 'settings-share-url',
  outcome: 'settings-outcome',
});

/** Build an <option> element. */
function makeOption(doc, value, label) {
  const opt = doc.createElement('option');
  opt.value = value;
  opt.textContent = label ?? value;
  return opt;
}

/** Build a touch-sized button. */
function makeButton(doc, id, text, cls) {
  const b = doc.createElement('button');
  b.id = id;
  b.className = cls || 'settings__button';
  b.setAttribute('type', 'button');
  b.textContent = text;
  return b;
}

/** Build a labelled section wrapper. */
function makeSection(doc, id, title) {
  const s = doc.createElement('section');
  s.id = id;
  s.className = 'settings__section';
  const h = doc.createElement('h2');
  h.className = 'settings__heading';
  h.textContent = title;
  s.append(h);
  return s;
}

/**
 * Create and mount the settings panel.
 *
 * @param {object} opts
 * @param {Document} opts.doc
 * @param {{ getState: Function, subscribe: Function }} opts.store  the shared store
 * @param {object} opts.controllers  { provider, connectors, skills, memory, lifecycle }
 * @param {() => (string|null)} [opts.getProjectId]  supplies the open project id for lifecycle ops
 * @returns {{ el: HTMLElement, render: () => void, destroy: () => void }}
 */
export function createSettingsPanel({ doc, store, controllers, getProjectId }) {
  const c = controllers || {};
  const projectId = typeof getProjectId === 'function' ? getProjectId : () => {
    const s = store.getState();
    return s.session && s.session.projectId ? s.session.projectId : null;
  };

  const root = doc.createElement('div');
  root.className = SETTINGS_DOM.rootClass;
  root.setAttribute('aria-label', 'Settings');

  // Shared, non-disclosing notice line (re-auth / error) from the store.
  const notice = doc.createElement('p');
  notice.id = SETTINGS_DOM.notice;
  notice.className = 'settings__notice';
  notice.setAttribute('role', 'alert');
  notice.hidden = true;
  root.append(notice);

  const unsubs = [];

  // ------------------------------------------------------------- PROVIDER
  const providerSection = makeSection(doc, SETTINGS_DOM.providerSection, 'Model provider');
  const providerActive = doc.createElement('p');
  providerActive.id = SETTINGS_DOM.providerActive;
  providerActive.className = 'settings__active';
  const providerSelect = doc.createElement('select');
  providerSelect.id = SETTINGS_DOM.providerSelect;
  providerSelect.className = 'settings__select';
  providerSelect.setAttribute('aria-label', 'Model provider');
  const providerApply = makeButton(doc, SETTINGS_DOM.providerApply, 'Apply provider', 'settings__button');
  providerSection.append(providerActive, providerSelect, providerApply);
  root.append(providerSection);

  function onProviderApply() {
    if (c.provider && typeof c.provider.select === 'function') void c.provider.select(providerSelect.value);
  }
  providerApply.addEventListener('click', onProviderApply);

  function renderProvider() {
    if (!c.provider) return;
    const st = c.provider.getState();
    const providers = Array.isArray(st.providers) ? st.providers : [];
    // Rebuild options only if the set changed length (cheap + rare).
    const desired = providers.map((p) => (typeof p === 'string' ? p : p.id)).filter(Boolean);
    const current = Array.from(providerSelect.options).map((o) => o.value);
    if (desired.length !== current.length || desired.some((v, i) => v !== current[i])) {
      providerSelect.replaceChildren();
      for (const p of providers) {
        const id = typeof p === 'string' ? p : p.id;
        const label = typeof p === 'string' ? p : p.label ?? p.id;
        if (id) providerSelect.append(makeOption(doc, id, label));
      }
    }
    if (typeof st.active === 'string') {
      providerActive.textContent = `Active: ${st.active}`;
      // Reflect the active/selected provider in the select (Req 12.3/12.4).
      if (typeof st.selected === 'string' && providerSelect.value !== st.selected) {
        providerSelect.value = st.selected;
      }
    } else {
      providerActive.textContent = 'No provider selected';
    }
    providerApply.disabled = st.inFlight === true;
  }
  if (c.provider && typeof c.provider.subscribe === 'function') unsubs.push(c.provider.subscribe(renderProvider));

  // ----------------------------------------------------------- CONNECTORS
  const connectorsSection = makeSection(doc, SETTINGS_DOM.connectorsSection, 'Connectors');
  const connectorsList = doc.createElement('div');
  connectorsList.className = 'settings__connectors';
  connectorsSection.append(connectorsList);
  root.append(connectorsSection);

  // Track secret inputs by service so we can clear them after submit (write-only).
  const secretInputs = new Map();

  function renderConnectors() {
    if (!c.connectors) return;
    const st = c.connectors.getState();
    const groups = typeof c.connectors.groups === 'function' ? c.connectors.groups() : [];
    const bound = st.bound || {};
    connectorsList.replaceChildren();
    secretInputs.clear();
    for (const group of groups) {
      const catEl = doc.createElement('div');
      catEl.className = 'settings__connector-category';
      const catTitle = doc.createElement('h3');
      catTitle.className = 'settings__subheading';
      catTitle.textContent = group.category;
      catEl.append(catTitle);
      for (const entry of group.entries) {
        const service = entry.service;
        const row = doc.createElement('div');
        row.className = 'settings__connector';

        const name = doc.createElement('span');
        name.className = 'settings__connector-name';
        name.textContent = service;
        row.append(name);

        // A write-only secret input. Its value is sent on configure() and the
        // field is cleared immediately after; the stored secret is NEVER shown.
        const secret = doc.createElement('input');
        secret.id = `${SETTINGS_DOM.connectorSecretPrefix}${service}`;
        secret.className = 'settings__connector-secret';
        secret.setAttribute('type', 'password');
        secret.setAttribute('autocomplete', 'off');
        secret.setAttribute('aria-label', `Secret for ${service}`);
        // The env-var NAME(s) this connector expects (reference-by-NAME only).
        const envNames = Array.isArray(entry.envNames) ? entry.envNames : [];
        if (envNames.length) secret.setAttribute('placeholder', envNames.join(', '));
        secretInputs.set(service, secret);
        row.append(secret);

        const configure = makeButton(
          doc,
          `${SETTINGS_DOM.connectorConfigurePrefix}${service}`,
          'Configure',
          'settings__button settings__connector-configure',
        );
        configure.addEventListener('click', async () => {
          const value = secret.value;
          // Build the secret map keyed by the connector's env NAMEs.
          const secrets = {};
          for (const n of envNames) secrets[n] = value;
          // Clear the input BEFORE awaiting so the plaintext is never left in
          // the field after submission (Req 13.3).
          secret.value = '';
          if (c.connectors && typeof c.connectors.configure === 'function') {
            await c.connectors.configure(service, secrets);
          }
        });
        row.append(configure);

        // Bound state (name-only; never a secret value) (Req 13.4).
        const boundEl = doc.createElement('span');
        boundEl.id = `${SETTINGS_DOM.connectorBoundPrefix}${service}`;
        boundEl.className = 'settings__connector-bound';
        const b = bound[service];
        if (b && b.status === 'active') {
          boundEl.textContent = `Bound (${(b.secretRefs || []).join(', ')})`;
          boundEl.setAttribute('data-bound', 'true');
        } else {
          boundEl.textContent = 'Not configured';
          boundEl.removeAttribute('data-bound');
        }
        row.append(boundEl);

        catEl.append(row);
      }
      connectorsList.append(catEl);
    }
  }
  if (c.connectors && typeof c.connectors.subscribe === 'function') unsubs.push(c.connectors.subscribe(renderConnectors));

  // --------------------------------------------------------------- SKILLS
  const skillsSection = makeSection(doc, SETTINGS_DOM.skillsSection, 'Skill library');
  const stockedList = doc.createElement('ul');
  stockedList.id = SETTINGS_DOM.skillsStocked;
  stockedList.className = 'settings__list';
  const userList = doc.createElement('ul');
  userList.id = SETTINGS_DOM.skillsUser;
  userList.className = 'settings__list';
  const skillName = doc.createElement('input');
  skillName.id = SETTINGS_DOM.skillName;
  skillName.className = 'settings__input';
  skillName.setAttribute('type', 'text');
  skillName.setAttribute('aria-label', 'Skill name');
  skillName.setAttribute('placeholder', 'skill-name');
  const skillBody = doc.createElement('textarea');
  skillBody.id = SETTINGS_DOM.skillBody;
  skillBody.className = 'settings__textarea';
  skillBody.setAttribute('aria-label', 'Skill body');
  skillBody.setAttribute('placeholder', 'Skill content\u2026');
  const skillAdd = makeButton(doc, SETTINGS_DOM.skillAdd, 'Add skill', 'settings__button');
  const skillImport = makeButton(doc, SETTINGS_DOM.skillImport, 'Import skill', 'settings__button');
  skillsSection.append(
    labelled(doc, 'Stocked skills', stockedList),
    labelled(doc, 'Your skills', userList),
    skillName,
    skillBody,
    skillAdd,
    skillImport,
  );
  root.append(skillsSection);

  function readSkill() {
    return { name: skillName.value, description: '', body: skillBody.value };
  }
  async function onSkillAdd() {
    if (c.skills && typeof c.skills.addSkill === 'function') {
      const out = await c.skills.addSkill(readSkill());
      if (out && out.ok) { skillName.value = ''; skillBody.value = ''; }
    }
  }
  async function onSkillImport() {
    if (c.skills && typeof c.skills.importSkill === 'function') {
      const out = await c.skills.importSkill(readSkill());
      if (out && out.ok) { skillName.value = ''; skillBody.value = ''; }
    }
  }
  skillAdd.addEventListener('click', onSkillAdd);
  skillImport.addEventListener('click', onSkillImport);

  function renderSkills() {
    if (!c.skills) return;
    const st = c.skills.getState();
    fillSkillList(doc, stockedList, st.stocked);
    fillSkillList(doc, userList, st.user);
    skillAdd.disabled = st.inFlight === true;
    skillImport.disabled = st.inFlight === true;
  }
  if (c.skills && typeof c.skills.subscribe === 'function') unsubs.push(c.skills.subscribe(renderSkills));

  // --------------------------------------------------------------- MEMORY
  const memorySection = makeSection(doc, SETTINGS_DOM.memorySection, 'Memory');
  const memoryMode = doc.createElement('select');
  memoryMode.id = SETTINGS_DOM.memoryMode;
  memoryMode.className = 'settings__select';
  memoryMode.setAttribute('aria-label', 'Memory mode');
  for (const m of MEMORY_MODES) memoryMode.append(makeOption(doc, m));
  const projectMem = doc.createElement('ul');
  projectMem.id = SETTINGS_DOM.memoryProject;
  projectMem.className = 'settings__list';
  const globalMem = doc.createElement('ul');
  globalMem.id = SETTINGS_DOM.memoryGlobal;
  globalMem.className = 'settings__list';
  memorySection.append(
    labelled(doc, 'Memory mode', memoryMode),
    labelled(doc, 'Project memory', projectMem),
    labelled(doc, 'Global memory', globalMem),
  );
  root.append(memorySection);

  function onMemoryMode() {
    if (c.memory && typeof c.memory.setMode === 'function') void c.memory.setMode(memoryMode.value);
  }
  memoryMode.addEventListener('change', onMemoryMode);

  function renderMemory() {
    if (!c.memory) return;
    const st = c.memory.getState();
    if (typeof st.mode === 'string' && memoryMode.value !== st.mode) memoryMode.value = st.mode;
    fillMemoryList(doc, projectMem, st.project, 'project', c.memory);
    fillMemoryList(doc, globalMem, st.global, 'global', c.memory);
  }
  if (c.memory && typeof c.memory.subscribe === 'function') unsubs.push(c.memory.subscribe(renderMemory));

  // ------------------------------------------------------------ LIFECYCLE
  const lifecycleSection = makeSection(doc, SETTINGS_DOM.lifecycleSection, 'Build, deploy, export & share');
  const buildBtn = makeButton(doc, SETTINGS_DOM.build, 'Build', 'settings__button');
  const deployBtn = makeButton(doc, SETTINGS_DOM.deploy, 'Deploy', 'settings__button');
  const exportBtn = makeButton(doc, SETTINGS_DOM.export, 'Export', 'settings__button');
  const auditBtn = makeButton(doc, SETTINGS_DOM.audit, 'Lock-in audit', 'settings__button');
  const shareBtn = makeButton(doc, SETTINGS_DOM.share, 'Create share link', 'settings__button');
  const outcome = doc.createElement('p');
  outcome.id = SETTINGS_DOM.outcome;
  outcome.className = 'settings__outcome';
  const auditList = doc.createElement('ul');
  auditList.id = SETTINGS_DOM.audit + '-list';
  auditList.className = 'settings__list';
  const shareUrl = doc.createElement('input');
  shareUrl.id = SETTINGS_DOM.shareUrl;
  shareUrl.className = 'settings__input settings__share-url';
  shareUrl.setAttribute('type', 'text');
  shareUrl.setAttribute('readonly', '');
  shareUrl.setAttribute('aria-label', 'Share link URL');
  shareUrl.hidden = true;
  lifecycleSection.append(buildBtn, deployBtn, exportBtn, auditBtn, shareBtn, outcome, auditList, shareUrl);
  root.append(lifecycleSection);

  buildBtn.addEventListener('click', () => { if (c.lifecycle) void c.lifecycle.build(projectId()); });
  deployBtn.addEventListener('click', () => { if (c.lifecycle) void c.lifecycle.deploy(projectId()); });
  exportBtn.addEventListener('click', () => { if (c.lifecycle) void c.lifecycle.export(projectId()); });
  auditBtn.addEventListener('click', () => { if (c.lifecycle) void c.lifecycle.audit(projectId()); });
  shareBtn.addEventListener('click', () => { if (c.lifecycle) void c.lifecycle.share(projectId()); });

  function renderLifecycle() {
    if (!c.lifecycle) return;
    const st = c.lifecycle.getState();
    const parts = [];
    if (st.build) parts.push(`Build: ${st.build.outcome}${st.build.summary ? ` — ${st.build.summary}` : ''}`);
    if (st.deploy) parts.push(`Deploy: ${st.deploy.outcome}${st.deploy.url ? ` (${st.deploy.url})` : ''}`);
    if (st.exported) parts.push('Export downloaded.');
    outcome.textContent = parts.join('  •  ');
    // Lock-in audit signals.
    auditList.replaceChildren();
    if (st.audit) {
      if (st.audit.clean || !st.audit.findings.length) {
        const li = doc.createElement('li');
        li.className = 'settings__list-item';
        li.textContent = 'No lock-in signals found.';
        auditList.append(li);
      } else {
        for (const f of st.audit.findings) {
          const li = doc.createElement('li');
          li.className = 'settings__list-item';
          const sig = f && typeof f === 'object' ? (f.signal || f.type || 'signal') : String(f);
          const loc = f && f.file ? ` — ${f.file}${f.line ? `:${f.line}` : ''}` : '';
          li.textContent = `${sig}${loc}`;
          auditList.append(li);
        }
      }
    }
    // Share URL (copyable).
    if (typeof st.shareUrl === 'string' && st.shareUrl) {
      shareUrl.value = st.shareUrl;
      shareUrl.hidden = false;
    } else {
      shareUrl.hidden = true;
    }
  }
  if (c.lifecycle && typeof c.lifecycle.subscribe === 'function') unsubs.push(c.lifecycle.subscribe(renderLifecycle));

  // ------------------------------------------------------------- NOTICE
  function renderNotice() {
    const s = store.getState();
    const n = s.session && s.session.notice;
    if (n && n.message) {
      let text = n.message;
      if (n.kind === 'rateLimited' && typeof n.limit === 'string' && n.limit) text = `${text} (${n.limit})`;
      notice.textContent = text;
      notice.hidden = false;
    } else {
      notice.textContent = '';
      notice.hidden = true;
    }
  }
  unsubs.push(store.subscribe((s) => s.session, renderNotice));

  /** Render every section (idempotent). */
  function render() {
    renderProvider();
    renderConnectors();
    renderSkills();
    renderMemory();
    renderLifecycle();
    renderNotice();
  }
  render();

  function destroy() {
    for (const u of unsubs) {
      try { u(); } catch { /* ignore */ }
    }
    providerApply.removeEventListener('click', onProviderApply);
    skillAdd.removeEventListener('click', onSkillAdd);
    skillImport.removeEventListener('click', onSkillImport);
    memoryMode.removeEventListener('change', onMemoryMode);
    root.remove();
  }

  return { el: root, render, destroy };
}

/** Wrap a control with a small label. */
function labelled(doc, text, control) {
  const wrap = doc.createElement('div');
  wrap.className = 'settings__field';
  const lab = doc.createElement('span');
  lab.className = 'settings__label';
  lab.textContent = text;
  wrap.append(lab, control);
  return wrap;
}

/** Fill a <ul> with skill list items (name + description). */
function fillSkillList(doc, ul, skills) {
  ul.replaceChildren();
  for (const s of Array.isArray(skills) ? skills : []) {
    const li = doc.createElement('li');
    li.className = 'settings__list-item';
    li.textContent = s.description ? `${s.name} — ${s.description}` : s.name;
    ul.append(li);
  }
}

/** Fill a <ul> with memory entries + inline edit/prune controls. */
function fillMemoryList(doc, ul, entries, scope, controller) {
  ul.replaceChildren();
  for (const e of Array.isArray(entries) ? entries : []) {
    const li = doc.createElement('li');
    li.className = 'settings__list-item settings__memory-entry';
    const text = doc.createElement('span');
    text.className = 'settings__memory-text';
    text.textContent = e.text;
    const prune = makeButton(doc, `settings-memory-prune-${scope}-${e.id}`, 'Prune', 'settings__button settings__button--small');
    prune.addEventListener('click', () => {
      if (controller && typeof controller.pruneEntry === 'function') void controller.pruneEntry(scope, e.id);
    });
    li.append(text, prune);
    ul.append(li);
  }
}
