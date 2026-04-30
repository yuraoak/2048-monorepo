# 2048 Monorepo

pnpm-монорепа: Vite/React клиент (Farcaster Mini App) + Hono API + Postgres + Redis + Go reconciler. Хостинг — Railway.

## Структура
- `apps/web` — Vite + React, игра 2048 в виде Farcaster Mini App
- `apps/api` — Hono на Node, ручки auth/game/leaderboard, проверка on-chain платежей за undo (viem, Base) и серверный рендер OG-картинок для шеринга в каст
- `apps/reconciler` — Go-воркер, который периодически сканирует treasury на Base и докидывает undo-кредиты пользователям, чьи платежи прошли on-chain, но `/api/shop/packs/buy` так и не успел их зачесть (закрытое приложение, обрыв сети, 5xx)
- Postgres хранит `scores` (лидерборд + снэпшот последней партии для шеринга), `undo_payments` (использованные tx-хэши), `undo_credits` (баланс undo на fid), `pack_intents` (durable-копия intent'ов для воркера), `reconciler_cursor` (последний просканированный блок) и `shares` (выпущенные share-ссылки)
- Redis хранит активные партии (`game:active:{fid}`), кэш лидерборда и rate-limit счётчики
- S3 (Railway Object Storage) хранит PNG-карточки, которые рендерит API при шеринге

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
- `API_PUBLIC_URL` — публичный origin самого API. Шеринг-страница `/share/:id` живёт здесь — именно эту ссылку клиент бросает в `composeCast`.
- `WEB_PUBLIC_URL` — публичный origin web-приложения. Подставляется в `fc:miniapp.button.action.url`, чтобы превью каста открывало мини-апп.
- `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_BUCKET` — S3-совместимое хранилище (Railway Object Storage) для PNG-картинок шеринга, virtual-hosted style. Регион хардкодится `"auto"` (Railway/R2/Minio его игнорят), публичный URL собирается сам как `https://${S3_BUCKET}.${endpoint-host}/${key}`. Без этих переменных эндпоинт `/api/share/create` отвечает 503.

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

## Шеринг в каст

После каждой завершённой игры на клиенте всплывает Game Over модалка со счётом, рангом и кнопкой «Share to Farcaster».

1. После `POST /api/scores/submit` бэкенд возвращает `last_game.score/max_tile` и флаг `new_best`. Клиент сразу открывает модалку.
2. Модалка стучится в `POST /api/share/create`. API:
   - читает снэпшот последней партии из `scores` (колонки `final_board`, `final_score`, `final_max_tile`, `seed`, `move_log` — сохраняются на каждый submit, даже если PB не побит);
   - считает ранг через `SELECT count(*) FROM scores WHERE score > final_score`;
   - тянет аватар, нормализует через `sharp` (любой формат — PNG/JPG/WebP/анимированный GIF: первый кадр берётся по умолчанию) и обрезает в круг;
   - рендерит 1200×800 PNG через `satori` (Inter Bold/Regular грузится с github.com и кешится в памяти процесса) → SVG → `@resvg/resvg-js`;
   - заливает PNG в S3 по ключу `shares/{id}.png` и сохраняет строку в `shares`;
   - возвращает `share_url = ${API_PUBLIC_URL}/share/{id}`.
3. Клиент зовёт `sdk.actions.composeCast({ embeds: [share_url] })`. Farcaster-клиент скрейпит `/share/:id` и видит `fc:miniapp` мету — рендерит rich-карточку с PNG-картинкой и кнопкой «Play 2048», которая ведёт обратно в `WEB_PUBLIC_URL`.

3:2 (1200×800) и сжатие через resvg — внутри лимитов Farcaster (≤10 МБ, 600×400…3000×2000).

## Reconciler (Go-воркер)

`apps/reconciler` — отдельный Go-сервис, который страхует hot-path `/api/shop/packs/buy`. Поток покупки полагается на то, что клиент после оплаты дойдёт до `/buy`; если приложение закрыли, отвалилась сеть или API вернул 5xx, on-chain платёж зависнет нечтённым, а пользователь останется без undo.

Чтобы это починить, при создании intent'а API теперь дублирует запись в Postgres — `pack_intents (nonce, fid, pack_id)`. Redis по-прежнему — fast-path для `/buy`, а Postgres — durable-источник для воркера.

Воркер на каждом тике (по умолчанию 60s):
1. Берёт `head` из Base RPC, считает `safe_head = head - UNDO_MIN_CONFIRMATIONS`.
2. Читает `reconciler_cursor.last_block`. На самом первом запуске стартует с `safe_head - RECONCILER_INITIAL_LOOKBACK` (≈28h истории), не реплеит весь Base.
3. Сканирует блоки `[cursor+1, safe_head]` (но не больше `RECONCILER_MAX_BLOCKS_PER_TICK` за раз) и собирает все tx с `to == TREASURY_ADDRESS` и `value > 0`.
4. Для каждой такой tx:
   - Если `tx_hash` уже в `undo_payments` — скип (зачёл API).
   - Если ресепт `status != success` — скип (revert).
   - По `value` вычисляет максимальный pack, у которого `priceWei ≤ value`, и `nonce = value - pack.priceWei`.
   - Идёт в `pack_intents` за `(fid, pack_id)` по этому nonce. Нет записи — лог-ворнинг и скип, без intent'а нельзя понять, кому начислять.
   - Если `pack_id` в intent'е не совпал с матченным паком — лог-ворнинг и скип.
   - Иначе одной транзакцией: `INSERT … undo_payments ON CONFLICT DO NOTHING` + `INSERT … undo_credits … ON CONFLICT … balance += pack.undos`. `ON CONFLICT` нужен на случай гонки с API — кто первый встал, тот и зачёл.
5. После каждого успешно обработанного блока двигает `reconciler_cursor`. Если внутри блока был транзиентный RPC-fail — курсор не двигается, на следующем тике ретрай.

Запуск локально: `cd apps/reconciler && go run .` (нужны `DATABASE_URL`, `TREASURY_ADDRESS`, опционально `BASE_RPC_URL`, `UNDO_MIN_CONFIRMATIONS`, `RECONCILER_INTERVAL`, `RECONCILER_MAX_BLOCKS_PER_TICK`, `RECONCILER_INITIAL_LOOKBACK`).

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
| `POST /share/create`    | 10 запросов  | 60s  |

Превышение — `429`. Если Redis недоступен, лимит fail-open: анти-чит держится не на лимите, а на серверном replay'е.

## Деплой на Railway

Пять сервисов в одном проекте:
- `Postgres` (managed)
- `Redis` (managed)
- `api` — Hono
- `web` — статика Vite (через `serve`)
- `reconciler` — Go-воркер (root directory `apps/reconciler`, `go run .`/`go build`)

Скрипты в корневом `package.json` готовы под Railway:
- `pnpm build:api` / `pnpm start:api` / `pnpm db:migrate`
- `pnpm build:web` / `pnpm start:web`

API ставится перед web, потому что `VITE_API_URL` зашивается в бандл на этапе билда — домен api должен существовать к моменту сборки фронта. CORS_ORIGIN/MINIAPP_DOMAIN для api — runtime, их можно дотянуть после деплоя web без пересборки.
