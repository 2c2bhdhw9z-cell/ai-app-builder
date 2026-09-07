# ai-app-builder in a container — the deployable unit of the platform.
#
# BUILD CONTEXT IS THE PARENT DIRECTORY, NOT THIS REPO. package.json declares
# `"plumby": "file:../plumby"`, so the engine is a sibling checkout rather than a
# registry package. A build context rooted at this repo therefore cannot see it and
# `npm ci` fails. Build from the directory that holds BOTH checkouts:
#
#   cd /path/containing/both
#   docker build -f ai-app-builder/Dockerfile -t ai-app-builder .
#
# Every COPY below is written relative to that parent, and each one is NARROW on
# purpose: naming the exact paths we need keeps .git, node_modules, test fixtures
# and local artifacts out of the image without depending on a .dockerignore that
# would have to live outside both repos to be honored.
#
# WHY THE DOCKER CLI IS INSTALLED HERE. Project sandboxes are not a side feature —
# they are where the Builder_Agent runs, and the SandboxManager reaches them by
# shelling out to a container CLI (src/sandbox/container-backend.js). node:22-slim
# ships no such binary, so an image without it boots and answers /healthz and can
# log in, but every POST /projects fails with 503 SANDBOX_ACQUIRE_FAILED. Build
# with --build-arg WITH_CONTAINER_CLI=false to skip it if you are deploying a
# surface-only instance and accept that.
#
# THE SOCKET MOUNT IS A REAL PRIVILEGE DECISION, read docs/DEPLOY.md before making
# it. Handing this container /var/run/docker.sock gives it the power to start
# containers on the host, which is root-equivalent on that host. It is the standard
# way to run this shape of workload and it is what the platform needs, but it means
# the container is not a security boundary against itself. Running the platform
# directly on the VM under systemd — where it simply uses the host's own docker —
# has the same privilege in a more obvious place, and is the recommended option.
#
# Secrets are NEVER baked in: every credential arrives at `docker run` time via -e
# or an env file. Runs as a NON-ROOT user.

ARG NODE_VERSION=22-slim

# ---------------------------------------------------------------- container CLI
# A separate stage so curl and the downloaded tarball never reach the final image.
# Only the `docker` client binary is taken — not the daemon, which is the host's.
FROM node:${NODE_VERSION} AS container-cli
ARG WITH_CONTAINER_CLI=true
ARG DOCKER_CLI_VERSION=27.3.1
ARG TARGETARCH
ARG DOCKER_CLI_SHA256=
RUN set -eux; \
    mkdir -p /out; \
    if [ "${WITH_CONTAINER_CLI}" != "true" ]; then exit 0; fi; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl; \
    rm -rf /var/lib/apt/lists/*; \
    arch="${TARGETARCH:-$(dpkg --print-architecture)}"; \
    case "$arch" in \
      amd64|x86_64) dl_arch='x86_64' ;; \
      arm64|aarch64) dl_arch='aarch64' ;; \
      *) echo "unsupported architecture: $arch" >&2; exit 1 ;; \
    esac; \
    # Download to a FILE rather than piping into tar. `sh` has no pipefail, so a
    # transfer that dies after tar has written its member would leave the pipeline
    # exiting 0 and ship a TRUNCATED binary — which then surfaces as
    # 503 SANDBOX_ACQUIRE_FAILED at run time instead of as a build failure.
    curl -fsSL -o /tmp/docker.tgz \
      "https://download.docker.com/linux/static/stable/${dl_arch}/docker-${DOCKER_CLI_VERSION}.tgz"; \
    # Supply --build-arg DOCKER_CLI_SHA256=<digest> to pin the exact bytes. This
    # binary is handed the host's docker socket, so pinning it is worth doing; the
    # digest is architecture-specific, hence opt-in rather than baked in.
    if [ -n "${DOCKER_CLI_SHA256}" ]; then \
      echo "${DOCKER_CLI_SHA256}  /tmp/docker.tgz" | sha256sum -c -; \
    fi; \
    tar -xzf /tmp/docker.tgz -C /out --strip-components=1 docker/docker; \
    rm -f /tmp/docker.tgz; \
    # Prove the extracted binary actually runs (catches truncation even unpinned).
    /out/docker --version

# ------------------------------------------------------------------ dependencies
# Split from the runtime stage so that installing dependencies is a separate layer
# from the application source copied into the runtime image. Note this stage DOES
# contain plumby's source (npm needs the file: target present), so editing plumby
# invalidates the install layer — only ai-app-builder source edits reuse it.
FROM node:${NODE_VERSION} AS deps
WORKDIR /srv

# plumby first: it is the file: target `npm ci` has to resolve. npm records it in
# the lockfile as a LINK, so it is never packed or fetched and its `files` field is
# never consulted — what matters is that everything reachable through
# src/engine/plumby.js exists, which is src/ (plus bin/ for the linked bin stubs).
# plumby has ZERO dependencies, so it is never itself installed.
COPY plumby/package.json ./plumby/package.json
COPY plumby/src ./plumby/src
COPY plumby/bin ./plumby/bin

# Then the manifests, so this layer caches independently of application source.
COPY ai-app-builder/package.json ai-app-builder/package-lock.json ./ai-app-builder/
WORKDIR /srv/ai-app-builder
# --omit=dev drops fast-check, which is only used by the test suite.
RUN npm ci --omit=dev

# ----------------------------------------------------------------------- runtime
FROM node:${NODE_VERSION} AS runtime
ENV NODE_ENV=production

# git is a RUNTIME dependency of the platform, not a build tool: the SnapshotStore
# shells out to the `git` CLI (src/persistence/snapshot-store.js) at the end of
# EVERY passing turn, and node:*-slim does not ship it. Omitting it does not crash
# anything — commitSnapshot catches the ENOENT and returns a structured failure — so
# the deploy would answer /healthz, log in, create projects, run turns that pass,
# and silently record ZERO snapshots: no history, no restore/resume, no fork, and
# nothing for publish-on-commit to publish. The systemd recipe in docs/DEPLOY.md
# installs git for exactly this reason; the image must not disagree with it.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends git; \
    rm -rf /var/lib/apt/lists/*

# Bind on all interfaces. A loopback bind inside a container is NOT reachable
# through `-p 8080:8080`: docker's port publishing connects to the container's own
# address, not its loopback. resolveBindConfig already defaults HOST to 0.0.0.0;
# setting it here makes the intent visible in `docker inspect`.
ENV HOST=0.0.0.0 \
    PORT=8080 \
    AAB_DATA_DIR=/var/lib/ai-app-builder

WORKDIR /srv
COPY --from=deps /srv/plumby ./plumby
COPY --from=deps /srv/ai-app-builder/node_modules ./ai-app-builder/node_modules
COPY ai-app-builder/package.json ai-app-builder/package-lock.json ./ai-app-builder/
COPY ai-app-builder/src ./ai-app-builder/src
COPY ai-app-builder/docs ./ai-app-builder/docs
COPY ai-app-builder/README.md ./ai-app-builder/

# The container CLI, when the build included it (an empty /out is a no-op).
COPY --from=container-cli /out/ /usr/local/bin/

# AAB_DATA_DIR holds BOTH the exportable Project trees and the control plane
# (registry, snapshots, secrets). It is the only durable state, so it is a mount
# point owned by the runtime user — losing it loses every Project.
#
# Mode 0700: this tree holds project secrets, the registry and snapshots, so it
# must not be world-readable — the SecretStore writes under the default umask, so
# the directory is where the restriction has to be applied.
RUN mkdir -p "${AAB_DATA_DIR}" \
  && chown -R node:node /srv "${AAB_DATA_DIR}" \
  && chmod 700 "${AAB_DATA_DIR}"
VOLUME ["/var/lib/ai-app-builder"]

USER node
WORKDIR /srv/ai-app-builder
EXPOSE 8080

# The unauthenticated readiness probe the server already serves. Uses global fetch
# (Node >= 20), so the image needs no curl at runtime. Deliberately probes 127.0.0.1
# rather than $HOST: 0.0.0.0 is a bind address, not a connect address.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

# CMD, not ENTRYPOINT, so `docker run ... ai-app-builder node -e ...` still works.
CMD ["npm", "start"]
