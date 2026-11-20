#!/usr/bin/env bash
# Uso: correr.sh [ids,separados|todos] [corridas] [salida-sin-extension]
# GASTA DINERO: llama a Claude de verdad. Necesita ANTHROPIC_API_KEY_2 en el
# entorno y la autorización de Jon (ver README.md). Solo llama a la API de
# Anthropic (el arnés bloquea cualquier otro host).
set -euo pipefail
D="$(cd "$(dirname "$0")" && pwd)"
R="$(cd "$D/../.." && pwd)"
export SALIDA="${3:-${TMPDIR:-/tmp}/salida-validar-bot}"
export JITI_ALIAS="{\"@/\":\"$R/src/\",\"@app-messages\":\"$R/messages/es.json\"}"
cd "$R" && node node_modules/jiti/lib/jiti-cli.mjs "$D/validar.ts" "${1:-todos}" "${2:-2}"
