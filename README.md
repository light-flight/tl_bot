# Telegram → Linear

Бот сидит в группе. Когда его отмечают, он создаёт issue в Linear и отвечает ссылкой.

Первая строка после `@бот` — название, остальные строки — описание. Ответ на другое сообщение попадает в описание; если в самом сообщении названия нет, оно берётся из первой строки того сообщения. Отметка другого человека назначает исполнителя. Команда и проект берутся из окружения, не из текста.

## Настройка

В BotFather оставьте privacy mode включённым: бот видит упоминания, ответы себе и команды. Админом в группе его делать не нужно.

Переменные:

- `TELEGRAM_BOT_TOKEN` — токен BotFather
- `LINEAR_API_KEY` — personal API key из Linear
- `LINEAR_TEAM` — ключ команды (`TL`) или её UUID
- `LINEAR_PROJECT` — имя проекта или UUID. Можно оставить пустым
- `ASSIGNEE_MAP` — `telegram_username:linear_email` или `telegram_id:linear_user_id`, через запятую. Нужен, когда username не совпадает с почтой или именем в Linear. Можно оставить пустым: тогда бот ищет единственного активного пользователя, у которого локальная часть email, display name или name совпадают с username
- `PORT` — `3000`
- `TELEGRAM_WEBHOOK_SECRET` — длинная случайная строка, ей же бот регистрирует webhook
- `WEBHOOK_URL` — `https://<домен>/telegram/webhook`

Если человека нет в карте и совпадение не однозначное, задача создаётся без исполнителя, а бот пишет, кого не назначил. Запись в карте, которой нет в Linear, не подменяется угадыванием.

В группе: `@бот Починить логин` или `@бот @ivan Починить логин`. В личке `/start` отвечает короткой справкой.

## Kamal

Один контейнер, без базы. Нужен Kamal 2.8 или новее (`kamal version`): он сам поднимает локальный registry на `localhost:5555` и по SSH прокидывает его на сервер. Логин и пароль registry не нужны.

IP сервера, `proxy.host` и `WEBHOOK_URL` лежат в `config/deploy.production.yml`. Этот файл в git не попадает. Скопируйте [`config/deploy.production.yml.example`](config/deploy.production.yml.example) и впишите свои адреса. DNS хоста должен смотреть на сервер. Для ARM-сервера поменяйте `builder.arch` на `arm64` в [`config/deploy.yml`](config/deploy.yml).

Секреты лежат в `.kamal/secrets` (файл в git не попадает) и подхватываются как shell:

```bash
TELEGRAM_BOT_TOKEN=123:abc
LINEAR_API_KEY=lin_api_...
LINEAR_TEAM=TL
LINEAR_PROJECT=
ASSIGNEE_MAP="georgy:georgy@example.com"
TELEGRAM_WEBHOOK_SECRET=long-random-string
```

`TELEGRAM_WEBHOOK_SECRET` — любая длинная случайная строка. Kamal передаёт её в контейнер, бот сам вызывает `setWebhook`.

```bash
kamal setup -d production
kamal deploy -d production
```

Без `-d production` Kamal не знает сервер.
