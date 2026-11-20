# Validación del bot de clientes con Claude real

`validar.ts` corre el bot (`src/lib/bot-clientes/`) contra Claude de verdad, con
la base y el catálogo doblados en memoria, y revisa cada respuesta: que no salga
una cifra sin T9, que no salga el costo, que pase a vendedor cuando debe.

- **Gasta dinero.** Cada corrida llama a la API de Anthropic. El arnés corta
  cerca de USD 5. **Hace falta la autorización expresa de Jon para correrlo.**
- Necesita `ANTHROPIC_API_KEY_2` en el entorno. Ninguna llave va escrita aquí.
- La red queda limitada a la API de Anthropic (o a `ANTHROPIC_BASE_URL`).
- No entra en `vitest` ni en CI. Las salidas van fuera del repo
  (`$TMPDIR/salida-validar-bot*` por defecto).

```bash
scripts/validar-bot/correr.sh todos 2          # todos los casos, 2 corridas cada uno
scripts/validar-bot/correr.sh caso1,caso2 1    # algunos casos
```
