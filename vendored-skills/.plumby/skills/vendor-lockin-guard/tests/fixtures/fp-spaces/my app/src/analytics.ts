// L11 regression pin: this file sits under a directory containing a space ("my app").
// The importFrom/mandated-package collection uses find/xargs with newline delimiting, and the
// scan uses grep -r, so a space in the path must not split the filename into broken arguments.
import posthog from 'posthog-js';
export const analytics = posthog;
