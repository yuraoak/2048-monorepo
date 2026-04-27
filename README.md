# 2048 Monorepo

pnpm-монорепа: React/Vite клиент + Hono API + Postgres. Хостинг — Railway.

## Структура
- `apps/web` — Vite + React, игра 2048
- `apps/api` — Hono на Node, эндпоинты лидерборда и сохранения игр
- Postgres хранит таблицы `scores` и `games`

## Локальный запуск
```bash
pnpm install
# поднять Postgres локально (например docker run -e POSTGRES_PASSWORD=pg -p 5432:5432 -d postgres:16)
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env
pnpm --filter @app/api db:migrate
pnpm dev
```

## Деплой на Railway
См. инструкции в конце настройки — три сервиса в одном проекте: `db` (Postgres), `api`, `web`.
