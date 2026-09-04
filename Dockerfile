# Container image for zotero-native-mcp.
#
# Read this before using it. The server talks to a Zotero running on your own
# machine, and Zotero guards its local API against DNS rebinding: it answers
# only requests whose Host header is 127.0.0.1 or localhost, and returns 400 to
# anything else. Pointing the container at host.docker.internal therefore fails,
# even though the host is reachable.
#
# What works is sharing the host's network, so that 127.0.0.1 inside the
# container is the machine running Zotero:
#
#   docker run -i --rm --network host zotero-native-mcp
#
# Verified with OrbStack on macOS. On Linux, where containers share the host's
# network stack directly, it should behave the same, though that has not been
# checked. Docker Desktop runs containers inside a VM, and its --network host
# does not reach the host's loopback, so this is unlikely to work there.
#
# Running the server directly with npx is simpler and is what the README
# recommends. This image exists for clients that are themselves containerised,
# and so that indexers can build and introspect the server reproducibly.

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/build ./build

# stdio transport: the client speaks to the process over stdin and stdout, so
# the container must be run with -i.
ENTRYPOINT ["node", "build/index.js"]
