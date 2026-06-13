# Проект: Reddit → Telegram Lead Bot

## Что за проект
Бот мониторит Reddit в поиске фриланс-заявок для Власа (украинский fullstack разработчик).
Находит посты по ключевым словам → скорит → генерирует ответ через Ollama → отправляет в Telegram для ручного копирования и отправки.
Авто-постинга на Reddit нет — только уведомление с готовым текстом ответа.

## Стек
- Node.js (CommonJS)
- Reddit public JSON API (без OAuth, анонимно)
- Telegram Bot API
- Ollama (локальная LLM, модель qwen2.5-coder:14b)
- dotenv, node-fetch

## Структура
```
bot.js          — основной файл, весь код в одном файле
prompt.js       — промпт для Ollama (профиль Власа, правила ответа, примеры)
test-ollama.js  — тест генерации ответа через Ollama + отправка в TG
.env            — конфиг (токены, ключи, флаги)
state.json      — lastSeenUtc по каждому сабреддиту (дедупликация по времени)
seen.json       — Set уже обработанных post ID (дедупликация по ID)
data/leads.jsonl — лог всех найденных лидов
```

## Как работает
1. Каждые 10 минут (INTERVAL_MINUTES) делает запрос к /r/subreddit/new.json
2. Фильтрует по ключевым словам (KEYWORDS из .env)
3. Применяет блеклист (adult content, chat jobs, warnings, job market posts и т.д.)
4. Скипает FOR HIRE посты ([Offer], [FOR HIRE], [FH]) — это конкуренты
5. На forhire/freelance_forhire скипает посты без [HIRING] тега — это обсуждения
6. Скорит лид (0-10): бюджет, дедлайн, стек, scope, тип, роль
7. Если score >= TG_MIN_SCORE (7) — генерирует ответ через Ollama
8. Отправляет в Telegram: заголовок, ссылка, стек, скор, готовый ответ

## Переменные .env
```
TG_BOT_TOKEN=       — токен Telegram бота
TG_CHAT_ID=         — ID чата куда слать
SUBREDDITS=forhire,freelance_forhire,jobbit,slavelabour,workonline
KEYWORDS=javascript,node,react,next,wordpress,opencart,shopify,frontend,fullstack,remote,contract
LIMIT_PER_SUB=100
INTERVAL_MINUTES=10
TG_MIN_SCORE=7
REQUEST_DELAY_MS=500
MAX_REQUESTS_PER_RUN=400
OLLAMA_URL=http://localhost:11434
OLLAMA_MODEL=qwen2.5-coder:14b
HN_ENABLED=false    — HackerNews отключен (full-time вакансии, не фриланс)
WWR_ENABLED=false   — WeWorkRemotely отключен (HTML в контенте, full-time)
DRY_RUN=false
RUN_ONCE=false
```

## Как запускать
```bash
node bot.js           # обычный режим, крутится по интервалу
node bot.js --once    # один прогон и выход
node test-ollama.js   # тест генерации ответа
```

## Сброс состояния (для теста)
```bash
echo '{"lastSeenUtc":{}}' > state.json
echo '{}' > seen.json
```

## Профиль Власа (для промпта)
- Украинский фриланс fullstack разработчик, 3 года опыта
- Специализация: WordPress, OpenCart, PHP, Node.js автоматизация
- Ставка: от $10/час, целевая $15+/час
- Лучшие лиды: WordPress/WooCommerce баги, OpenCart модули, Node.js боты/парсеры, API интеграции, e-commerce checkout/payment/delivery
- Плохие лиды: чистый дизайн, iOS native, blockchain, enterprise Java/.NET, ML research, full-time onsite, бесплатная работа

## Известные особенности
- Reddit OAuth не настроен, бот работает через публичный API (лимиты мягче)
- Если REDDIT_CLIENT_ID не пустой — бот пытается OAuth и падает с 401. Оставлять пустым.
- seen.json растёт неограниченно — при большом размере можно чистить старые записи
- Ollama должна быть запущена локально на порту 11434
- Таймаут на Ollama запрос: 30 секунд (AbortController)
