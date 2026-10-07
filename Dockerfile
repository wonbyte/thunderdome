# The donor image ships sandbox-shim, the helper that @cloudflare/sandbox Files runs.
# Keep its tag equal to the installed @cloudflare/sandbox version.
ARG SANDBOX_TOOLS_IMAGE=docker.io/cloudflare/sandbox:1.0.0
FROM ${SANDBOX_TOOLS_IMAGE} AS sandbox-tools

FROM docker.io/library/node:24-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates git ripgrep \
  && rm -rf /var/lib/apt/lists/*
# The agents. The postinstall script copies the native binary into place, so do not skip scripts.
RUN npm install --global @anthropic-ai/claude-code@2.1.280
# Builds each fork push's Workers Preview. Keep equal to package.json's wrangler.
RUN npm install --global wrangler@4.147.0
COPY --from=sandbox-tools /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
# The claim board CLI the agents use.
COPY image/claim.mjs /usr/local/bin/claim
RUN chmod 755 /usr/local/bin/claim
# Commits and pushes the agent's work as it goes (a Claude Code PostToolUse hook).
COPY image/autopush.mjs /usr/local/bin/autopush
RUN chmod 755 /usr/local/bin/autopush
RUN git config --system user.name "Thunderdome" \
  && git config --system user.email "thunderdome@users.noreply.local" \
  && git config --system init.defaultBranch main
# The judge runs robot-written tests as this user: it can read a clone, which root owns, but not
# change it or the tools (src/judge/judge.ts asTester).
RUN useradd --system --create-home --home-dir /home/tester --shell /usr/sbin/nologin tester
WORKDIR /workspace
CMD ["sleep", "infinity"]
