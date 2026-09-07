// H21 regression pin: a real telemetry import whose own line mentions an excluded path
// (/dist/, node_modules, /build/ ...) must STILL be reported. EXCLUDES applies to the PATH
// of the finding, never to its matched source text — otherwise appending "// node_modules"
// to a tracking import would hide it from CI forever.
import * as Sentry from '@sentry/browser'; // build output goes to /dist/, not node_modules
