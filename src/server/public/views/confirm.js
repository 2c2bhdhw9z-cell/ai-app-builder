/*
 * views/confirm.js — the confirm-class approval view (spec Task 6.1; design
 * §"Views — views/confirm.js", Req 5.1, 5.3, 5.4, 11.3).
 *
 * A thin DOM renderer over the confirm controller (confirm.js) and the store
 * (Task 2.1). It renders one approve/deny card per PENDING Confirm_Prompt (the
 * store's pendingConfirms slice, keyed by requestId), sizes the approve/deny
 * controls for touch (Req 11.3), keeps each prompt visible while it is
 * unanswered (Req 5.3), and — because it renders from the requestId-keyed store
 * slice — re-displays a replayed still-pending confirm IDEMPOTENTLY on reconnect
 * without stacking duplicates (Req 5.4). It holds NO business logic: the
 * decision, the POST /confirm call, and the 401/timeout mapping all live in
 * confirm.js; this module only builds nodes and forwards the approve/deny intent.
 *
 * Idempotence on replay (Req 5.4): the store's CONFIRM_ADDED reducer de-dupes an
 * identical re-add to the SAME pendingConfirms reference, so a subscription on
 * the pendingConfirms selector does NOT fire for a no-op replay — the view is
 * never asked to re-render a prompt that did not change. When it DOES re-render
 * (a confirm added or cleared), it rebuilds one card per requestId, so the set
 * on screen is exactly the set of pending confirms — one card per requestId,
 * never two for the same id.
 *
 * CSP hygiene (Req 1.4): nodes are built with the DOM API only — NO innerHTML,
 * NO inline event-handler attributes, NO inline <style>. Listeners are attached
 * with addEventListener; all colors come from the palette-driven `--color-*`
 * custom properties via styles.css, never inline.
 *
 * Structure to stay unit-testable without a DOM: the PURE part — projecting the
 * pendingConfirms map into an ordered list of view rows — is exported as
 * `confirmViewModel` so a `node --test` can assert the projection (one row per
 * requestId, carrying the safe display fields) without a browser; the
 * DOM-touching `createConfirmView` is kept deliberately thin over it.
 */

import { selectPendingConfirms } from '../store.js';

/** Stable DOM ids/classes so the view is greppable and styleable. */
export const CONFIRM_DOM = Object.freeze({
  rootClass: 'confirm',
  listClass: 'confirm__list',
  cardClass: 'confirm__card',
  commandClass: 'confirm__command',
  reasonClass: 'confirm__reason',
  approve: 'confirm__approve',
  deny: 'confirm__deny',
  // data attribute carrying the requestId so a card is keyed + testable.
  keyAttr: 'data-request-id',
});

/**
 * Pure view-model: project the store's pendingConfirms map into an ordered list
 * of rows the view renders — one row per requestId, carrying ONLY the safe
 * display fields the confirm_request frame provided. Exported so a DOM-free test
 * asserts the projection (real store slice in, plain rows out).
 *
 * Rows are ordered by requestId for a stable, deterministic render (the map's
 * own key order is insertion order, which a reconnect replay could perturb; a
 * stable sort keeps the on-screen order from churning on replay).
 *
 * @param {{ session: { pendingConfirms: Record<string, any> } }} state
 * @returns {Array<{ requestId: string, command: string, category: string, reason: string }>}
 */
export function confirmViewModel(state) {
  const pending = selectPendingConfirms(state) ?? {};
  return Object.keys(pending)
    .sort()
    .map((requestId) => {
      const p = pending[requestId] ?? {};
      return {
        requestId,
        command: typeof p.command === 'string' ? p.command : '',
        category: typeof p.category === 'string' ? p.category : '',
        reason: typeof p.reason === 'string' ? p.reason : '',
      };
    });
}

/**
 * Create and mount the confirm view.
 *
 * @param {object} opts
 * @param {Document} opts.doc                 the document to build nodes in
 * @param {{ getState: Function, subscribe: Function }} opts.store
 * @param {{ approve: Function, deny: Function }} opts.controller  the confirm controller
 * @returns {{ el: HTMLElement, render: () => void, destroy: () => void }}
 */
export function createConfirmView({ doc, store, controller }) {
  const root = doc.createElement('section');
  root.className = CONFIRM_DOM.rootClass;
  root.setAttribute('aria-label', 'Command approvals');
  // A live region so a newly-arrived confirm is announced to assistive tech.
  root.setAttribute('role', 'region');
  root.setAttribute('aria-live', 'polite');

  const list = doc.createElement('ul');
  list.className = CONFIRM_DOM.listClass;
  root.append(list);

  /**
   * Build one approve/deny card for a pending confirm row.
   * @param {{ requestId: string, command: string, category: string, reason: string }} row
   */
  function buildCard(row) {
    const card = doc.createElement('li');
    card.className = CONFIRM_DOM.cardClass;
    card.setAttribute(CONFIRM_DOM.keyAttr, row.requestId);
    card.setAttribute('role', 'group');

    const command = doc.createElement('p');
    command.className = CONFIRM_DOM.commandClass;
    // The category (if any) prefixes the command so the user sees what class of
    // action is being approved; both are safe, frame-provided display strings.
    command.textContent = row.category ? `${row.category}: ${row.command}` : row.command;
    card.append(command);

    if (row.reason) {
      const reason = doc.createElement('p');
      reason.className = CONFIRM_DOM.reasonClass;
      reason.textContent = row.reason;
      card.append(reason);
    }

    const approve = doc.createElement('button');
    approve.className = CONFIRM_DOM.approve;
    approve.setAttribute('type', 'button');
    approve.textContent = 'Approve';
    approve.addEventListener('click', () => {
      // Fire-and-forget: the controller maps the outcome onto the store, which
      // re-renders this view (clearing the card on success).
      void controller.approve(row.requestId);
    });

    const deny = doc.createElement('button');
    deny.className = CONFIRM_DOM.deny;
    deny.setAttribute('type', 'button');
    deny.textContent = 'Deny';
    deny.addEventListener('click', () => {
      void controller.deny(row.requestId);
    });

    const controls = doc.createElement('div');
    controls.className = 'confirm__controls';
    controls.append(approve, deny);
    card.append(controls);

    return card;
  }

  /**
   * Apply the pure view-model to the DOM. Rebuilds the card list from the
   * current pending confirms so the on-screen set is EXACTLY the set of pending
   * confirms (one card per requestId). Idempotent: called for a no change is
   * harmless, and because the store de-dupes an identical replay, the
   * subscription does not even fire for a no-op re-add (Req 5.4).
   */
  function render() {
    const rows = confirmViewModel(store.getState());
    // The whole section is hidden when nothing is pending, so it takes no space
    // in the layout until a confirm arrives.
    root.hidden = rows.length === 0;
    const cards = rows.map(buildCard);
    list.replaceChildren(...cards);
  }

  // Re-render whenever the pendingConfirms slice reference changes — i.e. a
  // confirm is added or cleared. An idempotent replay is a no-op reference-wise
  // (store de-dup), so this does not fire for it (Req 5.4).
  const unsubscribe = store.subscribe(selectPendingConfirms, render);
  render();

  function destroy() {
    unsubscribe();
    root.remove();
  }

  return { el: root, render, destroy };
}
