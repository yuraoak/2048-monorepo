FROM node:20-alpine AS builder
WORKDIR /repo
RUN npm install -g pnpm@10.12.1
COPY pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/package.json
RUN pnpm install --filter @app/api... --frozen-lockfile=false
COPY apps/api apps/api
RUN pnpm --filter @app/api build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN npm install -g pnpm@10.12.1
COPY pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/package.json
RUN pnpm install --filter @app/api --prod --frozen-lockfile=false
COPY --from=builder /repo/apps/api/dist apps/api/dist
EXPOSE 8080
CMD ["node", "apps/api/dist/index.js"]
