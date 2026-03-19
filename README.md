# OpenClaw Dashboard

Простой веб-дешборд для управления OpenClaw gateway на Linux (Ubuntu).

## Возможности

- **Статус** — индикатор состояния gateway (Running / Stopped / Unknown)
- **Start** — запуск gateway
- **Restart** — перезапуск gateway
- **Stop** — остановка gateway

## Установка

```bash
cd openclaw-dashboard
npm install
```

## Запуск

```bash
npm start
```

Дешборд будет доступен на `http://localhost:3142`.

### Переменные окружения

- `PORT` — порт сервера (по умолчанию 3142)
- `DASHBOARD_PASSWORD` — пароль для доступа (если не задан, доступ без пароля)

## Публичный доступ через Cloudflare Tunnel

Для получения временной публичной ссылки используется **Cloudflare Quick Tunnels** (бесплатно).

### 1. Установка cloudflared

**Ubuntu/Debian:**
```bash
curl -L --output cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
sudo dpkg -i cloudflared.deb
```

**Или через snap:**
```bash
sudo snap install cloudflared
```

### 2. Запуск туннеля

В одном терминале запустите дешборд:
```bash
npm start
```

В другом терминале:
```bash
npm run tunnel
```

Или напрямую:
```bash
cloudflared tunnel --url http://localhost:3142
```

В выводе появится временная ссылка вида:
```
https://random-string.trycloudflare.com
```

Эта ссылка действует пока запущен процесс `cloudflared`. После остановки — ссылка перестаёт работать.

### Безопасность

При использовании публичного туннеля **обязательно** задайте пароль:

```bash
DASHBOARD_PASSWORD=your-secret-password npm start
```

Затем в другом терминале:
```bash
cloudflared tunnel --url http://localhost:3142
```

## Требования

- Node.js 18+
- OpenClaw установлен и доступен в PATH (`openclaw` CLI)
- Linux (Ubuntu) — для управления gateway
