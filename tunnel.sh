#!/bin/sh
# Cloudflare Quick Tunnel — временная публичная ссылка на дешборд
# Запустите сначала: npm start
# Затем: ./tunnel.sh

PORT="${PORT:-3142}"
exec cloudflared tunnel --url "http://localhost:${PORT}"
