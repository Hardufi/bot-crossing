# Bot Crossing in a container.
#
# The colony is a reader: it needs each harness's own session directory mounted from the
# host, and it writes exactly one file. That file is why /data is a volume rather than part
# of the image — the map you have learned should survive `docker compose down`.
#
# The server itself imports nothing but node builtins, so the runtime stage carries no
# node_modules at all: the dependencies exist only to build the page.

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY server ./server

# Bind every interface. The port is published to the host, and `isLocalRequest` in
# server/api.mjs still refuses any request whose Host or Origin is not a local address,
# so this widens what the socket listens on and not what the API will answer.
ENV BOT_CROSSING_HOST=0.0.0.0
ENV BOT_CROSSING_DATA=/data
ENV HOME=/home/node
# Where the Linux build of the Claude Code adapter looks for desktop sessions:
# $XDG_CONFIG_HOME/Claude/claude-code-sessions (server/harnesses/claude-code.mjs:33).
ENV XDG_CONFIG_HOME=/config

# The map lives in a named volume. Docker seeds a fresh volume from the image, ownership
# included, so /data has to be node-owned *here* — otherwise the volume mounts root-owned,
# the server runs as `node`, and the one file this app writes fails with EACCES.
RUN mkdir -p /data && chown node:node /data

USER node
EXPOSE 5274
CMD ["node", "server/serve.mjs"]
