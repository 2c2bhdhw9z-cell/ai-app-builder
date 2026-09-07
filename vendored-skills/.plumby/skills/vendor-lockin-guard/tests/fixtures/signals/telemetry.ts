// HIGH signal: telemetry / analytics SDK import.
import * as Sentry from '@sentry/browser';
import posthog from 'posthog-js';

export function boot() {
  Sentry.init({});
  posthog.init('token');
}
