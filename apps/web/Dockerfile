FROM node:20-alpine AS builder
WORKDIR /repo
RUN npm install -g pnpm@10.12.1
COPY pnpm-workspace.yaml package.json ./
COPY apps/web/package.json apps/web/package.json
RUN pnpm install --filter @app/web... --frozen-lockfile=false
COPY apps/web apps/web
ARG VITE_API_URL
ENV VITE_API_URL=${VITE_API_URL}
RUN pnpm --filter @app/web build

FROM node:20-alpine AS runner
WORKDIR /app
RUN npm install -g pnpm@10.12.1
COPY pnpm-workspace.yaml package.json ./
COPY apps/web/package.json apps/web/package.json
RUN pnpm install --filter @app/web --prod --frozen-lockfile=false
COPY --from=builder /repo/apps/web/dist apps/web/dist
COPY --from=builder /repo/apps/web/vite.config.ts apps/web/vite.config.ts
ENV PORT=4173
EXPOSE 4173
CMD ["pnpm", "--filter", "@app/web", "preview"]
