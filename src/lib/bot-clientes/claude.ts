// ============================================================
// Una llamada del bot de clientes a Claude (Messages API), con herramientas.
// Por `fetch`, como el resto de los proveedores de wacrm (`lib/ai/providers`),
// y con el `fetch` inyectable para probar sin red: las pruebas NUNCA llaman a
// la API de verdad.
//
// Modelo fijo `claude-sonnet-5-5` (decisión de Jon, 20-nov). Esfuerzo bajo: es
// un chat de clientes con respuestas cortas. El prompt del sistema y las
// herramientas no cambian entre llamadas, así que van primero y con caché.
// ============================================================

import { MODELO_BOT } from './costo';

/** `ANTHROPIC_BASE_URL` si existe (un proxy o el arnés de validación). */
export function urlMensajes(env: Record<string, string | undefined> = process.env): string {
  const base = (env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, '');
  return `${base}/v1/messages`;
}
const VERSION_API = '2023-06-01';
const MAX_TOKENS = 2048;

export type BloqueContenido = { type: string; [k: string]: unknown };

export interface MensajeClaude {
  role: 'user' | 'assistant';
  content: string | BloqueContenido[];
}

export interface HerramientaClaude {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  strict?: boolean;
}

export interface RespuestaClaude {
  stop_reason: string | null;
  content: BloqueContenido[];
  usage: unknown;
}

export class ErrorClaude extends Error {
  readonly estadoHttp: number | null;
  /** El `usage` si la API lo mandó aunque la respuesta no sirva (se cobra igual). */
  readonly usage: unknown;
  constructor(mensaje: string, estadoHttp: number | null, usage: unknown = null) {
    super(mensaje);
    this.name = 'ErrorClaude';
    this.estadoHttp = estadoHttp;
    this.usage = usage;
  }
}

export type Fetch = typeof fetch;

export async function llamarClaude(args: {
  apiKey: string;
  sistema: string;
  herramientas: HerramientaClaude[];
  mensajes: MensajeClaude[];
  timeoutMs: number;
  fetchImpl?: Fetch;
}): Promise<RespuestaClaude> {
  const f = args.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await f(urlMensajes(), {
      method: 'POST',
      headers: {
        'x-api-key': args.apiKey,
        'anthropic-version': VERSION_API,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODELO_BOT,
        max_tokens: MAX_TOKENS,
        output_config: { effort: 'low' },
        system: [{ type: 'text', text: args.sistema, cache_control: { type: 'ephemeral' } }],
        tools: args.herramientas,
        tool_choice: { type: 'auto' },
        messages: args.mensajes,
      }),
      signal: AbortSignal.timeout(args.timeoutMs),
    });
  } catch (err) {
    // Corte de red o tiempo agotado: no hay `usage`. El bot anota una fila en
    // cero para que quede rastro de la llamada.
    const tiempo = err instanceof DOMException && err.name === 'TimeoutError';
    throw new ErrorClaude(
      `${tiempo ? 'Se agotó el tiempo con Claude' : 'No se pudo hablar con Claude'}: ${err instanceof Error ? err.message : String(err)}`,
      null
    );
  }
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) {
    const detalle = (json?.error as { message?: string } | undefined)?.message ?? '';
    // Si la respuesta no 2xx trae `usage`, se anota: lo que se cobra cuenta para el tope.
    throw new ErrorClaude(
      `Claude respondió ${res.status}${detalle ? `: ${detalle}` : ''}`,
      res.status,
      json?.usage ?? null
    );
  }
  if (!json || !Array.isArray(json.content)) {
    throw new ErrorClaude('Claude devolvió una respuesta sin contenido.', res.status, json?.usage ?? null);
  }
  return {
    stop_reason: typeof json.stop_reason === 'string' ? json.stop_reason : null,
    content: json.content as BloqueContenido[],
    usage: json.usage,
  };
}
