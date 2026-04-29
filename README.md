# 2048 Monorepo

pnpm-монорепа: React/Vite клиент + Hono API + Postgres + Redis (опционально). Хостинг — Railway / Lizard.

## Структура
- `apps/web` — Vite + React, игра 2048
- `apps/api` — Hono на Node, эндпоинты лидерборда и сохранения игр
- Postgres хранит таблицы `scores` и `games`
- Redis (опционально) кэширует ответы лидерборда

## Локальный запуск
```bash
pnpm install
# поднять Postgres локально (например docker run -e POSTGRES_PASSWORD=pg -p 5432:5432 -d postgres:16)
# опционально поднять Redis: docker run -p 6379:6379 -d redis:7
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env
pnpm --filter @app/api db:migrate
pnpm dev
```

## Кэш лидерборда (Redis)

`GET /api/scores` использует cache-aside поверх Redis. Если `REDIS_URL` не задан, кэш молча отключается и API работает напрямую с Postgres — это удобно для локальной разработки без Redis.

- **Ключ:** `scores:top:{limit}:{offset}` — отдельная запись на каждую страницу.
- **TTL:** 15 секунд (`SCORES_CACHE_TTL` в `apps/api/src/index.ts`).
- **Инвалидация:** `POST /api/scores` после успешного апдейта вызывает `SCAN` + `DEL` по паттерну `scores:top:*`. То есть свежий рекорд виден сразу, а не через TTL.
- **Диагностика:** ответ помечается заголовком `X-Cache: HIT|MISS`.

Проверить локально:
```bash
curl -i http://localhost:8080/api/scores | grep -i x-cache  # MISS
curl -i http://localhost:8080/api/scores | grep -i x-cache  # HIT
```

Клиент Redis — `ioredis`, инициализация в `apps/api/src/cache.ts`. Все ошибки кэша логируются и не пробрасываются наружу: если Redis упал, API продолжит отдавать данные из Postgres.

## Anti-cheat: серверный replay

`POST /api/scores` **не принимает скор от клиента**. Вместо `{ score, max_tile, moves }` клиент отправляет `{ seed, moves }`, где:

- `seed` — uint32, выбирается клиентом в начале партии и используется как сид PRNG;
- `moves` — компактная строка ходов вида `"udlrur..."` (`u/d/l/r` ↔ up/down/left/right), потолок 100 000 символов.

Сервер прогоняет ту же 2048-логику с тем же сидом (Mulberry32 PRNG, идентичная реализация в `apps/api/src/replay.ts` и `apps/web/src/game.ts`), вычисляет авторитативные `score`/`max_tile`/`moves` и пишет в БД именно их. Подделать невозможно: чтобы получить score N, нужно прислать реальную последовательность ходов, дающую N после replay'а.

**Ограничения, о которых стоит помнить:**
- `username` и `pfp_url` всё ещё приходят от клиента. Уникальность в БД по `fid`, но отображаемое имя можно подменить. Чинится тягой имени из Farcaster API на сервере.
- На клиенте `seed` и move log хранятся в `localStorage` (`2048.seed`, `2048.moves`). Если очистить хранилище или зайти с другого устройства — partition без replay'а, submit на лидерборд недоступен до начала новой партии. Серверный snapshot в `games` остаётся для удобного resume, но без submit.

## Rate limiting

`POST /api/scores` ограничен **5 submissions в минуту на fid** через Redis (`INCR` + `EXPIRE` на ключе `ratelimit:scores:{fid}`). Превышение — `429`. Если Redis недоступен, лимит fail-open (пропускает) — анти-чит держится не на rate limit'е, а на replay'е.

## Деплой на Railway / Lizard
Четыре сервиса в одном проекте:
- `db` — Postgres
- `cache` — Redis (опционально, но рекомендуется)
- `api` — Hono
- `web` — статика Vite

На Railway: жмёшь "Add Service → Database → Redis", он автоматически прокидывает `REDIS_URL` в переменные проекта. Привязываешь её в сервисе `api` через reference (`${{Redis.REDIS_URL}}`). На Lizard аналогично — поднимаешь Redis-сервис рядом и указываешь его URL в env у `api`.

Если `REDIS_URL` не указан — деплой всё равно поднимется, просто без кэша.
