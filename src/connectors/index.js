/**
 * Connectors subsystem barrel (spec Task 21).
 *
 * The public seam for managed Connectors, mirroring how src/sandbox/index.js and
 * src/secrets/index.js aggregate their modules. Callers compose a
 * ConnectorService from a SecretStore, a ConnectorBindingStore, a steering
 * writer, and an injected capture seam (the OAuth/API-key boundary), plus a
 * CommandGuard for hosting-deploy routing. The Connector_Catalog provides the
 * concrete Connectors across all six Connector_Categories.
 */

export { createConnectorService } from './connector-service.js';

export { createConnectorCatalog, defaultConnectorCatalog } from './catalog.js';

export { createConnectorBindingStore } from './binding-store.js';

export {
  createConnectorsSteeringWriter,
  renderConnectorsManifest,
  STEERING_DIR,
  CONNECTORS_MANIFEST_FILE,
} from './steering.js';
