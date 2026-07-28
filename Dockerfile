# syntax=docker/dockerfile:1

# Build the TypeScript sources with the full dependency tree.
FROM node:24-alpine AS build
WORKDIR /app

# Copied before the sources so the install layer is reused whenever only code
# changed, which is most of the time.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Resolve the runtime dependency tree separately, so devDependencies never
# reach the final image. --ignore-scripts because nothing here needs to run
# lifecycle hooks and it is one less thing executing at build time.
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

FROM node:24-alpine AS runtime
ENV NODE_ENV=production

# 0.0.0.0 is already the default, but a container that binds to loopback is
# unreachable from outside and the symptom is indistinguishable from a crash.
ENV HOST=0.0.0.0
ENV PORT=3000

WORKDIR /app
COPY --from=deps  /app/node_modules ./node_modules
COPY --from=build /app/dist         ./dist
COPY package.json ./

# The node image ships an unprivileged `node` user; nothing here needs root.
USER node

EXPOSE 3000

# No curl or wget in the base image, and adding one only for this would grow the
# image. Node has a global fetch.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Exec form, so node runs as PID 1 and receives SIGTERM directly. The server
# registers a SIGTERM handler and closes the listener, which is what makes
# `docker stop` a graceful shutdown rather than a 10-second wait and a kill.
CMD ["node", "dist/node/index.js"]
