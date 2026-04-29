# 2048 Monorepo

pnpm-монорепа: Vite/React клиент (Farcaster Mini App) + Hono API + Postgres + Redis. Хостинг — Railway.

## Структура
- `apps/web` — Vite + React, игра 2048 в виде Farcaster Mini App
- `apps/api` — Hono на Node, ручки auth/game/leaderboard и проверка on-chain платежей за undo (viem, Base)
- Postgres хранит `scores` (лидерборд) и `undo_payments` (использованные tx-хэши)
- Redis хранит активные партии (`game:active:{fid}`), кэш лидерборда и rate-limit счётчики

## Локальный запуск
```bash
pnpm install
# Postgres: docker run -e POSTGRES_PASSWORD=pg -p 5432:5432 -d postgres:16
# Redis:    docker run -p 6379:6379 -d redis:7
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env
pnpm db:migrate
pnpm dev
```

Web по умолчанию на `:5173`, API на `:8080`. Игра работает только внутри Farcaster — снаружи показывается fallback-страница.

## Переменные окружения

**API (`apps/api/.env`):**
- `DATABASE_URL` — Postgres
- `REDIS_URL` — Redis. Обязателен для game state и undo; кэш лидерборда без него молча отключается.
- `PORT` (по умолчанию 8080), `CORS_ORIGIN`
- `MINIAPP_DOMAIN` — хост фронта (без схемы). Quick Auth выпускает JWT, привязанные к этому домену; API сверяет `aud`.
- `TREASURY_ADDRESS` — адрес на Base, куда уходят платежи за undo
- `BASE_RPC_URL` (по умолчанию `https://mainnet.base.org`), `UNDO_PRICE_WEI` (по умолчанию 0.0005 ETH), `UNDO_MIN_CONFIRMATIONS`

**Web (`apps/web/.env`):**
- `VITE_API_URL` — base URL API

## Архитектура: server-authoritative game state

Игра целиком авторитативна на сервере. Клиент локально только рендерит и накапливает анимации; источник истины — пара `(seed, move_log)` в Redis.

- `POST /api/games/start` (auth) — стартует партию, сервер генерит `seed`, кладёт в Redis.
- `POST /api/games/state` (auth) — текущее состояние (для resume).
- `POST /api/games/move` (auth) — `{ dirs: "udlr…", expectedLen }`. Сервер прогоняет batch ходов на своей доске, отбрасывает no-op, обновляет `move_log` атомарно через Lua-скрипт CAS (`gameStore.ts:APPEND_SCRIPT`). `expectedLen` защищает от гонок: если длина лога на сервере уехала — `409` и клиент делает resync.
- `POST /api/scores/submit` (auth) — ничего не принимает, кроме опциональных `username`/`pfp_url`. Сервер сам проверяет `over=true` по своему состоянию, считает финальный score через `replay()` и пишет в `scores` через `INSERT … ON CONFLICT (fid) DO UPDATE WHERE EXCLUDED.score > scores.score`.

Подделать score невозможно: клиент не отправляет ни score, ни доску.

Replay (`apps/api/src/replay.ts`) — детерминированный: Mulberry32 PRNG + ровно та же merge-логика, что на клиенте (`apps/web/src/game.ts`).

## Auth: Farcaster Quick Auth

Клиент использует `@farcaster/miniapp-sdk` (`sdk.quickAuth.fetch`), который автоматически прикладывает Bearer JWT к каждому запросу. Сервер (`apps/api/src/auth.ts`) валидирует токен через `@farcaster/quick-auth`, сверяя `aud` с `MINIAPP_DOMAIN`, и кладёт `fid` в контекст хендлера.

## Undo через on-chain платёж (Base)

Откатить последний ход стоит 0.0005 ETH на Base. Поток intent-based:

1. `POST /api/games/undo/intent` — сервер инкрементит nonce в Redis (`undo:intent:counter`), сохраняет `{ fid }` под `undo:intent:{nonce}` (TTL 10 мин), возвращает `amount_wei = base_price + nonce` и адрес treasury.
2. Клиент (`apps/web/src/wallet.ts`) шлёт ровно `amount_wei` на treasury через Farcaster embedded wallet.
3. `POST /api/games/undo` с `txHash` — сервер через viem проверяет: tx подтверждена, статус success, recipient = treasury, value ≥ base_price, нужное количество подтверждений. Из `value - base_price` восстанавливает nonce, по nonce — fid; сверяет с авторизованным.
4. Tx-хэш клеймится в `undo_payments` (PK = tx_hash → защита от повторного использования). Только после этого Lua-скрипт `POP_SCRIPT` атомарно срезает последний символ `move_log`. Если pop падает — строка `undo_payments` откатывается, чтобы tx можно было переотправить.

Почему intent через `value`, а не calldata: embedded-кошелёк Farcaster переписывает/дропает calldata на простых ETH-переводах. Уникальный `value` — единственный надёжный канал привязки fid к платежу.

## Кэш лидерборда (Redis)

`GET /api/scores` — cache-aside поверх Redis.
- Ключ: `scores:top:{limit}:{offset}` — отдельная запись на каждую страницу.
- TTL: 15 секунд (`SCORES_CACHE_TTL` в `apps/api/src/index.ts`).
- Инвалидация: `POST /api/scores/submit` после успешного апдейта делает `SCAN` + `DEL` по паттерну `scores:top:*` (`cacheInvalidatePattern`).
- Диагностика: заголовок `X-Cache: HIT|MISS`.

Все ошибки кэша логируются и не пробрасываются — если Redis упадёт, лидерборд продолжит отдаваться напрямую из Postgres.

## Rate limiting

Через Redis `INCR + EXPIRE` (`cache.ts:rateLimit`), на ключ `ratelimit:{op}:{fid}`:

| Операция                | Лимит        | Окно |
|-------------------------|--------------|------|
| `POST /games/move`      | 240 запросов | 60s  |
| `POST /scores/submit`   | 5 запросов   | 60s  |
| `POST /games/undo`      | 10 запросов  | 60s  |
| `POST /games/undo/intent` | 10 запросов | 60s  |

Превышение — `429`. Если Redis недоступен, лимит fail-open: анти-чит держится не на лимите, а на серверном replay'е.

## Деплой на Railway

Четыре сервиса в одном проекте:
- `Postgres` (managed)
- `Redis` (managed)
- `api` — Hono
- `web` — статика Vite (через `serve`)

Скрипты в корневом `package.json` готовы под Railway:
- `pnpm build:api` / `pnpm start:api` / `pnpm db:migrate`
- `pnpm build:web` / `pnpm start:web`

API ставится перед web, потому что `VITE_API_URL` зашивается в бандл на этапе билда — домен api должен существовать к моменту сборки фронта. CORS_ORIGIN/MINIAPP_DOMAIN для api — runtime, их можно дотянуть после деплоя web без пересборки.
