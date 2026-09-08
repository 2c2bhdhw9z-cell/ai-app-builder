/*
 * views/prompt.js — the core-builder prompt view (spec Task 3.2; design
 * §"Views — views/prompt.js", Req 2.1, 2.5, 11.3).
 *
 * A thin DOM renderer over the builder controller (Task 3.1) and the store
 * (Task 2.1). It renders a textarea (1–10,000 chars) plus a submit control,
 * disables both while a turn is in flight, sizes the controls for touch, and
 * shows the non-disclosing notice the controller sets. It holds NO business
 * logic: validation, the network call, and the timeout/401/429 mapping all live
 * in `builder.js`; this module only builds nodes and forwards intent.
 *
 * CSP hygiene (Req 1.4): nodes are built with the DOM API only — NO innerHTML,
 * NO inline event-handler attributes, NO inline <style>. Listeners are attached
 * with addEventListener. All colors come from the palette-driven `--color-*`
 * custom properties via the shared stylesheet (styles.css), never inline.
 *
 * Structure to stay unit-testable without a DOM: the PURE parts — the element
 * ids/classes, the disabled/enabled decision, and the notice text projection —
 * are exported as pure helpers (`promptViewModel`) so a `node --test` can assert
 * the view's decisions without a browser; the DOM-touching `createPromptView`
 * is kept deliberately thin over those helpers.
 */

import {
  ACTIONS,
  selectSubmitInFlight,
} from '../store.js';
import { PROMPT_MAX } from '../builder.js';

/** Stable DOM ids/classes so the view is greppable and styleable. */
export const PROMPT_DOM = Object.freeze({
  form: 'prompt-form',
  textarea: 'prompt-input',
  submit: 'prompt-submit',
  notice: 'prompt-notice',
  indicator: 'prompt-running-indicator',
  rootClass: 'prompt',
});

/**
 * Pure view-model: given the relevant store slice, decide what the view should
 * show. Exported so a DOM-free test asserts the disabled/enabled + notice
 * decisions directly (real store slice in, plain decision out).
 *
 * @param {{ session: { submitInFlight: boolean, pendingPromptText: string, notice: any } }} state
 * @returns {{
 *   inFlight: boolean,
 *   submitDisabled: boolean,
 *   textareaDisabled: boolean,
 *   text: string,
 *   notice: { kind: string, message: string, limit: (string|null) } | null,
 *   noticeText: string,
 * }}
 */
export function promptViewModel(state) {
  const inFlight = selectSubmitInFlight(state);
  const session = state.session ?? {};
  const notice = session.notice ?? null;
  // A named rate-limit notice appends the backend-named limit to the generic
  // client message so the user sees WHICH limit was hit (Req 2.8) without any
  // other backend detail.
  let noticeText = '';
  if (notice) {
    noticeText = notice.message ?? '';
    if (notice.kind === 'rateLimited' && typeof notice.limit === 'string' && notice.limit) {
      noticeText = `${noticeText} (${notice.limit})`.trim();
    }
  }
  return {
    inFlight,
    submitDisabled: inFlight,
    textareaDisabled: inFlight,
    text: typeof session.pendingPromptText === 'string' ? session.pendingPromptText : '',
    notice,
    noticeText,
  };
}

/**
 * Create and mount the prompt view.
 *
 * @param {object} opts
 * @param {Document} opts.doc                 the document to build nodes in
 * @param {{ getState: Function, dispatch: Function, subscribe: Function }} opts.store
 * @param {{ submit: Function }} opts.controller   the builder controller (Task 3.1)
 * @returns {{ el: HTMLElement, render: () => void, destroy: () => void }}
 */
export function createPromptView({ doc, store, controller }) {
  const root = doc.createElement('section');
  root.className = PROMPT_DOM.rootClass;
  root.setAttribute('aria-label', 'Prompt');

  const form = doc.createElement('form');
  form.id = PROMPT_DOM.form;
  form.className = 'prompt__form';
  // No inline handler attribute — attached below with addEventListener.
  form.setAttribute('novalidate', '');

  const textarea = doc.createElement('textarea');
  textarea.id = PROMPT_DOM.textarea;
  textarea.className = 'prompt__input';
  textarea.setAttribute('name', 'prompt');
  textarea.setAttribute('rows', '4');
  // The input affordance mirrors the validator's upper bound (Req 2.1); the
  // lower bound (>=1 after trim) is enforced by the controller on submit.
  textarea.setAttribute('maxlength', String(PROMPT_MAX));
  textarea.setAttribute('aria-label', 'Describe or refine your app');
  textarea.setAttribute('placeholder', 'Describe or refine your app\u2026');

  const submit = doc.createElement('button');
  submit.id = PROMPT_DOM.submit;
  submit.className = 'prompt__submit';
  submit.setAttribute('type', 'submit');
  submit.textContent = 'Send';

  const indicator = doc.createElement('span');
  indicator.id = PROMPT_DOM.indicator;
  indicator.className = 'prompt__indicator';
  indicator.setAttribute('role', 'status');
  indicator.setAttribute('aria-live', 'polite');
  indicator.hidden = true;
  indicator.textContent = 'Working\u2026';

  const notice = doc.createElement('p');
  notice.id = PROMPT_DOM.notice;
  notice.className = 'prompt__notice';
  notice.setAttribute('role', 'alert');
  notice.hidden = true;

  form.append(textarea, submit, indicator);
  root.append(form, notice);

  // Keep the store's retained text in sync as the user types, so a re-render
  // (e.g. after a timeout/429 that retains text) never clobbers what they see
  // and a retry keeps their work.
  function onInput() {
    store.dispatch({ type: ACTIONS.PROMPT_TEXT_SET, text: textarea.value });
  }

  async function onSubmit(ev) {
    ev.preventDefault();
    // Read the live textarea value; the controller trims + validates.
    await controller.submit(textarea.value);
  }

  textarea.addEventListener('input', onInput);
  form.addEventListener('submit', onSubmit);

  /** Apply the pure view-model to the DOM. Idempotent. */
  function render() {
    const vm = promptViewModel(store.getState());
    // Only overwrite the textarea when the store's retained text differs from
    // what is displayed, so we don't stomp the caret mid-typing.
    if (textarea.value !== vm.text) textarea.value = vm.text;
    submit.disabled = vm.submitDisabled;
    textarea.disabled = vm.textareaDisabled;
    indicator.hidden = !vm.inFlight;
    if (vm.noticeText) {
      notice.textContent = vm.noticeText;
      notice.hidden = false;
    } else {
      notice.textContent = '';
      notice.hidden = true;
    }
  }

  // Re-render whenever the session slice changes (in-flight, notice, text).
  const unsubscribe = store.subscribe((s) => s.session, render);
  render();

  function destroy() {
    unsubscribe();
    textarea.removeEventListener('input', onInput);
    form.removeEventListener('submit', onSubmit);
    root.remove();
  }

  return { el: root, render, destroy };
}
