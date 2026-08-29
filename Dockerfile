# Two stages so the runtime image carries no build toolchain and no dev deps.
FROM node:24-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
# tsx runs TypeScript directly. Deliberate: this repo is meant to be READ and
# edited by whoever deploys it, and a compile step puts a build artifact between
# the source you changed and the thing that is running.
RUN npm install -g tsx@4
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json triage.config.ts ./
COPY src ./src
COPY packs ./packs
COPY scripts ./scripts

# Never run as root. The service reads a handbook and calls an HTTPS API; it has
# no business being able to write to its own image.
USER node
EXPOSE 8787

# A container that starts successfully while unable to reach its store or its
# credentials is a container that will page you later instead of now.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:8787/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["tsx", "src/server.ts"]
