# Авторизация CRM-дашборда внутри Битрикс24

## Цель

Дашборд открывается из placement `LEFT_MENU` внутри Битрикс24 и показывает CRM-данные именно текущего пользователя. Локальная разработка может использовать персональный ключ владельца, но production не должен получать или использовать этот ключ.

## Подтверждённое состояние

- `BITRIX_APP_KEY` распознаётся Vibe API как `oauth_app`.
- Грант приложения содержит `crm`, `user` и `placement`.
- Placement `LEFT_MENU` уже зарегистрирован для приложения «Дашборд».
- Сервер `dashbord` существует: `STANDALONE`, `running`, `CONNECTED`, `accessPolicy=AUTHENTICATED`.
- Gateway передаёт серверу `X-Vibe-Authorization: Bearer vibe_session_*` при открытии placement.
- Текущий `server.js` использует только `BITRIX_API_KEY`, поэтому игнорирует пользовательскую сессию.

## Архитектура

### Production

Сервер получает `X-Vibe-Authorization` от Gateway. Для каждого запроса к Vibe API он отправляет:

- `X-Api-Key: <BITRIX_APP_KEY>`;
- `Authorization: Bearer <vibe_session_текущего пользователя>`.

В production передаются только `BITRIX_APP_KEY`, `BITRIX_API_BASE_URL` и `BITRIX_PORTAL_DOMAIN`. `BITRIX_API_KEY` не включается в архив или deploy environment.

### Локальная разработка

Персональный `BITRIX_API_KEY` разрешён только при явном `BITRIX_ALLOW_PERSONAL_FALLBACK=true`. Без пользовательской сессии и без этого флага API отвечает `401` с инструкцией открыть приложение внутри Битрикс24.

### Изоляция кэша

Cache scope вычисляется как SHA-256 от session token или персонального ключа. Значение токена/ключа никогда не сохраняется в ключе кэша и не выводится. Pipeline, KPI, справочник стадий и справочник пользователей кэшируются внутри scope; данные одного пользователя не могут быть отданы другому.

### UI и ошибки

`GET /api/meta` сообщает `connected`, `configured` и `authMode`. В placement `authMode=placement`; локально с разрешённым fallback — `personal`. При отсутствии session UI показывает, что приложение нужно открыть внутри Битрикс24.

### Деплой

Обновляется существующий сервер `dashbord`, новый сервер не создаётся. Архив содержит только runtime-файлы (`package.json`, `server.js`, модуль авторизации и `public/`). В HTML добавляется platform favicon `/_gw/icon`; SVG-иконка загружается отдельно. После deploy проверяются health endpoint, access policy, placement registration и ответы API через Gateway.

## Тестирование

- app-key имеет приоритет при наличии корректного `X-Vibe-Authorization`;
- outbound headers содержат app-key и `Authorization`;
- персональный fallback требует явного флага;
- разные sessions получают разные cache scopes;
- cache scope не содержит исходный secret;
- локальный smoke-test с personal fallback сохраняет существующее поведение;
- production-конфигурация без session не раскрывает CRM-данные.

## Ограничения

- Код остаётся без внешних npm-зависимостей и использует Node.js built-in APIs.
- Все CRM-операции остаются read-only.
- Ключи и session tokens не логируются и не попадают в архив.
- Существующая бизнес-логика KPI и фильтров не меняется.
