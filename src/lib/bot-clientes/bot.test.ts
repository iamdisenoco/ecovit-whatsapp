// El bot de clientes (bloque 6) con dobles: NUNCA llama a Claude ni a Zernio.
import { beforeEach, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { atenderConBot, mensajesParaClaude, paraElModelo, type DependenciasBot } from './bot';
import { ErrorClaude, llamarClaude, type RespuestaClaude } from './claude';
import { costoUsd, leerUso } from './costo';
import { revisarRespuesta } from './revisor';
import { t3PasoConAsesor, t9PrecioLista, TEXTOS } from './textos';

type Rpc = { fn: string; args: Record<string, unknown> };

let rpcs: Rpc[];
let enviados: string[];
let llamadas: number;
let respuestasClaude: (RespuestaClaude | Error)[];
let puedeSecuencia: { puede: boolean; motivo: string | null }[];
let claim: boolean;
let catalogo: Record<string, unknown>[];
let paso: Record<string, unknown>;
let escribiendoLlamado: number;

function db(): SupabaseClient {
  return {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcs.push({ fn, args });
      switch (fn) {
        case 'bot_puede_contestar_wa':
          return { data: puedeSecuencia.length > 1 ? puedeSecuencia.shift() : puedeSecuencia[0], error: null };
        case 'catalogo_cliente_wa':
          return { data: { referencias: catalogo }, error: null };
        case 'pasar_a_vendedor_wa':
          return { data: paso, error: null };
        case 'claim_ai_reply_slot':
          return { data: claim, error: null };
        default:
          return { data: { id: 'x' }, error: null };
      }
    },
    from: (tabla: string) => {
      const b: Record<string, unknown> = {};
      for (const m of ['select', 'eq']) b[m] = () => b;
      b.maybeSingle = async () =>
        tabla === 'perfiles'
          ? { data: { nombre: 'Carlos Pérez' }, error: null }
          : { data: { ai_reply_count: 0 }, error: null };
      return b;
    },
  } as unknown as SupabaseClient;
}

function deps(): DependenciasBot {
  return {
    db: db(),
    configuracion: async () => ({ apiKey: 'k-falsa', cupoPorChat: 5 }),
    llamar: async () => {
      llamadas++;
      const r = respuestasClaude.shift();
      if (!r) throw new Error('el doble no tiene más respuestas');
      if (r instanceof Error) throw r;
      return r;
    },
    contexto: async () => [{ role: 'user', content: '¿Precio del fluxómetro FX-1?' }],
    escribiendo: async () => {
      escribiendoLlamado++;
    },
    enviarTexto: async (t) => {
      enviados.push(t);
    },
  };
}

const uso = { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 2000, cache_creation_input_tokens: 0 };
const texto = (t: string): RespuestaClaude => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: t }], usage: uso });
const herramienta = (name: string, input: Record<string, unknown>): RespuestaClaude => ({
  stop_reason: 'tool_use',
  content: [{ type: 'tool_use', id: 'tu1', name, input }],
  usage: uso,
});
const fns = () => rpcs.map((r) => r.fn);

beforeEach(() => {
  rpcs = [];
  enviados = [];
  llamadas = 0;
  respuestasClaude = [];
  puedeSecuencia = [{ puede: true, motivo: null }];
  claim = true;
  catalogo = [
    { codigo: 'FX-1', descripcion: 'Fluxómetro orinal', unidad: 'UND', precio_base: 148000, disponibilidad: 3 },
    { codigo: 'FX-2', descripcion: 'Fluxómetro sanitario', unidad: 'UND', precio_base: null, disponibilidad: 'a confirmar' },
  ];
  paso = { en_espera: false, destino_id: 'p-carlos', repetido: false };
  escribiendoLlamado = 0;
});

describe('cuándo NO contesta (cero llamadas a la IA)', () => {
  for (const motivo of ['ia_apagada', 'ia_pausada', 'chat_con_dueno', 'fuera_de_lista_blanca', 'tope_sin_definir']) {
    it(`${motivo}: silencio, sin llamar a Claude ni escribir al cliente`, async () => {
      puedeSecuencia = [{ puede: false, motivo }];
      const r = await atenderConBot(deps(), 'c1');
      expect(r).toEqual({ accion: 'silencio', motivo });
      expect(llamadas).toBe(0);
      expect(escribiendoLlamado).toBe(0);
      expect(enviados).toEqual([]);
      expect(fns()).toEqual(['bot_puede_contestar_wa']);
    });
  }

  it('tope alcanzado: pasa el chat con motivo tope y manda T6, sin llamar a Claude', async () => {
    puedeSecuencia = [{ puede: false, motivo: 'tope_alcanzado' }];
    const r = await atenderConBot(deps(), 'c1');
    expect(llamadas).toBe(0);
    expect(rpcs.find((x) => x.fn === 'pasar_a_vendedor_wa')?.args.p_motivo).toBe('tope');
    expect(enviados).toEqual([TEXTOS.T6.plantilla]);
    expect(r.accion).toBe('paso');
  });
});

describe('contesta', () => {
  it('busca, y el precio lo pone el código con T9; el gasto se anota por llamada', async () => {
    respuestasClaude = [
      herramienta('buscar_referencias', { texto: 'FX-1' }),
      texto('Sí, el fluxómetro para orinal FX-1 está disponible.\n[[PRECIO:FX-1]]'),
    ];
    const r = await atenderConBot(deps(), 'c1');
    expect(r.accion).toBe('respondio');
    expect(enviados).toHaveLength(1);
    expect(enviados[0]).toContain(t9PrecioLista(148000, 'UND'));
    expect(enviados[0]).not.toContain('[[PRECIO');
    // T10 no está aprobado: no sale.
    expect(enviados[0]).not.toContain('asistente de ECOVIT');
    const usos = rpcs.filter((x) => x.fn === 'registrar_uso_ia_wa');
    expect(usos).toHaveLength(2);
    expect(usos[0].args).toMatchObject({
      p_modelo: 'claude-sonnet-5-5',
      p_tokens_entrada: 1000,
      p_tokens_salida: 100,
      p_cache_lectura: 2000,
      p_cache_escritura: 0,
      p_costo_usd: costoUsd(leerUso(uso)),
    });
    // Justo antes de enviar, reclama el cupo.
    expect(fns().indexOf('claim_ai_reply_slot')).toBeGreaterThan(fns().lastIndexOf('registrar_uso_ia_wa'));
  });

  it('muestra «escribiendo…» cuando va a pensar, y si falla igual contesta', async () => {
    const d = deps();
    let escribio = 0;
    d.escribiendo = async () => {
      escribio++;
      throw new Error('Meta 400');
    };
    respuestasClaude = [texto('Hola, ¿qué referencia buscas?')];
    const r = await atenderConBot(d, 'c1');
    expect(escribio).toBe(1);
    expect(r.accion).toBe('respondio');
  });

  it('el modelo nunca ve el número del precio', () => {
    const json = paraElModelo(catalogo as never);
    expect(json).not.toContain('148000');
    expect(JSON.parse(json)[0]).toMatchObject({ codigo: 'FX-1', tiene_precio_de_lista: true });
    expect(JSON.parse(json)[1]).toMatchObject({ tiene_precio_de_lista: false });
  });

  it('si una persona tomó el chat mientras pensaba, no envía (y el gasto queda anotado)', async () => {
    claim = false;
    respuestasClaude = [texto('Hola, ¿en qué te ayudo?')];
    const r = await atenderConBot(deps(), 'c1');
    expect(r).toEqual({ accion: 'descartado', motivo: 'chat_tomado_o_cupo' });
    expect(enviados).toEqual([]);
    expect(fns()).toContain('registrar_uso_ia_wa');
  });
});

describe('pasa a una persona', () => {
  it('el modelo escribe una cifra de plata: no sale, pasa con sin_dato y T4 (y el gasto se anota)', async () => {
    respuestasClaude = [texto('Ese fluxómetro vale $148.000')];
    await atenderConBot(deps(), 'c1');
    expect(rpcs.find((x) => x.fn === 'pasar_a_vendedor_wa')?.args.p_motivo).toBe('sin_dato');
    expect(enviados).toEqual([TEXTOS.T4.plantilla.replace('{asesor}', 'Carlos')]);
    expect(fns()).toContain('registrar_uso_ia_wa');
  });

  it('precio de una referencia sin precio de lista: no inventa, pasa con T4', async () => {
    respuestasClaude = [herramienta('buscar_referencias', { texto: 'FX-2' }), texto('[[PRECIO:FX-2]]')];
    await atenderConBot(deps(), 'c1');
    expect(rpcs.find((x) => x.fn === 'pasar_a_vendedor_wa')?.args.p_motivo).toBe('sin_dato');
  });

  it('descuento: T5 + T3 con el nombre del vendedor de la cartera y la condición', async () => {
    respuestasClaude = [herramienta('pasar_a_vendedor', { motivo: 'descuento', resumen: 'Pide 15 % por 200 FX-1' })];
    await atenderConBot(deps(), 'c1');
    const p = rpcs.find((x) => x.fn === 'pasar_a_vendedor_wa');
    expect(p?.args).toMatchObject({ p_motivo: 'descuento', p_resumen: 'Pide 15 % por 200 FX-1' });
    expect(enviados).toEqual([`${TEXTOS.T5.plantilla}\n\n${t3PasoConAsesor('Carlos', 'descuento')}`]);
    expect(enviados[0]).toContain('Lo de descuento queda pendiente');
  });

  it('sin cartera (en espera): T3 sin nombre propio', async () => {
    paso = { en_espera: true, destino_id: 'p-admin', repetido: false };
    respuestasClaude = [herramienta('pasar_a_vendedor', { motivo: 'pide_persona', resumen: 'Quiere hablar con alguien' })];
    await atenderConBot(deps(), 'c1');
    expect(enviados).toEqual(['Listo, un asesor de ECOVIT ya tiene tu solicitud y te escribe para continuar.']);
  });

  it('Claude falla sin usage (red, tiempo): T6, pasa, y deja una fila de uso en cero', async () => {
    respuestasClaude = [new ErrorClaude('Se agotó el tiempo con Claude', null)];
    await atenderConBot(deps(), 'c1');
    expect(rpcs.find((x) => x.fn === 'pasar_a_vendedor_wa')?.args.p_motivo).toBe('otro');
    expect(enviados).toEqual([TEXTOS.T6.plantilla]);
    expect(rpcs.find((x) => x.fn === 'registrar_uso_ia_wa')?.args).toMatchObject({
      p_tokens_entrada: 0,
      p_tokens_salida: 0,
      p_costo_usd: 0,
    });
  });

  it('Claude responde no 2xx CON usage: se anota lo cobrado', async () => {
    respuestasClaude = [new ErrorClaude('Claude respondió 500', 500, { input_tokens: 500, output_tokens: 0 })];
    await atenderConBot(deps(), 'c1');
    expect(rpcs.find((x) => x.fn === 'registrar_uso_ia_wa')?.args).toMatchObject({
      p_tokens_entrada: 500,
      p_costo_usd: 0.001,
    });
  });

  it('respuesta cortada (max_tokens): no se manda el texto, pasa con T6', async () => {
    respuestasClaude = [{ stop_reason: 'max_tokens', content: [{ type: 'text', text: 'El fluxómetro FX-1 es' }], usage: uso }];
    await atenderConBot(deps(), 'c1');
    expect(enviados).toEqual([TEXTOS.T6.plantilla]);
    expect(fns()).toContain('pasar_a_vendedor_wa');
    expect(fns()).not.toContain('claim_ai_reply_slot');
  });

  it('una persona tomó el chat antes del paso: ni pasa ni le escribe al cliente', async () => {
    puedeSecuencia = [{ puede: true, motivo: null }, { puede: false, motivo: 'chat_con_dueno' }];
    respuestasClaude = [herramienta('pasar_a_vendedor', { motivo: 'queja', resumen: 'Queja' })];
    const r = await atenderConBot(deps(), 'c1');
    expect(r).toEqual({ accion: 'silencio', motivo: 'chat_con_dueno' });
    expect(fns()).not.toContain('pasar_a_vendedor_wa');
    expect(enviados).toEqual([]);
  });
});

describe('llamarClaude (con fetch falso)', () => {
  it('no 2xx con usage: lanza ErrorClaude con el usage', async () => {
    const f = (async () =>
      new Response(JSON.stringify({ error: { message: 'x' }, usage: { input_tokens: 7 } }), { status: 500 })) as typeof fetch;
    const err = await llamarClaude({ apiKey: 'k', sistema: 's', herramientas: [], mensajes: [], timeoutMs: 1000, fetchImpl: f }).catch((e) => e);
    expect(err).toBeInstanceOf(ErrorClaude);
    expect(err.usage).toEqual({ input_tokens: 7 });
  });
  it('manda el modelo claude-sonnet-5-5', async () => {
    let cuerpo: Record<string, unknown> = {};
    const f = (async (_u: unknown, init: RequestInit) => {
      cuerpo = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ stop_reason: 'end_turn', content: [], usage: {} }), { status: 200 });
    }) as unknown as typeof fetch;
    await llamarClaude({ apiKey: 'k', sistema: 's', herramientas: [], mensajes: [], timeoutMs: 1000, fetchImpl: f });
    expect(cuerpo.model).toBe('claude-sonnet-5-5');
  });
});

describe('piezas', () => {
  it('costo Sonnet 5.5: 2 / 10 / 0,10 / 2,50 USD por millón', () => {
    expect(costoUsd({ entrada: 1_000_000, salida: 0, cacheLectura: 0, cacheEscritura: 0 })).toBe(2);
    expect(costoUsd({ entrada: 0, salida: 1_000_000, cacheLectura: 0, cacheEscritura: 0 })).toBe(10);
    expect(costoUsd({ entrada: 0, salida: 0, cacheLectura: 1_000_000, cacheEscritura: 0 })).toBe(0.1);
    expect(costoUsd({ entrada: 0, salida: 0, cacheLectura: 0, cacheEscritura: 1_000_000 })).toBe(2.5);
    expect(costoUsd({ entrada: 1000, salida: 100, cacheLectura: 2000, cacheEscritura: 0 })).toBe(0.0032);
  });

  it('la marca de precio de algo no consultado o sin precio no sale', () => {
    const refs = new Map([['FX-9', { codigo: 'FX-9', descripcion: 'x', unidad: null, precio_base: null }]]);
    expect(revisarRespuesta('[[PRECIO:NO-EXISTE]]', refs, PERMITIDOS).ok).toBe(false);
    expect(revisarRespuesta('[[PRECIO:FX-9]]', refs, PERMITIDOS).ok).toBe(false);
  });

  it('a Claude le llegan turnos alternados que empiezan por el cliente', () => {
    expect(
      mensajesParaClaude([
        { role: 'assistant', content: 'saludo' },
        { role: 'user', content: 'a' },
        { role: 'user', content: 'b' },
      ]),
    ).toEqual([{ role: 'user', content: 'a\n\nb' }]);
  });
});

// ── Revisor por lista blanca (tercera revisión) ─────────────────────────────
// Lo que el modelo vio de la herramienta en el turno: es lo único que da
// permiso a un número. Sin precios (así lo arma `paraElModelo`).
const PERMITIDOS = paraElModelo([
  { codigo: 'FX-1020', descripcion: 'Fluxómetro 1/2 pulgada para orinal 3.5 lpf', unidad: 'UND', precio_base: 148000, disponibilidad: 12 },
  { codigo: '1020', descripcion: 'Llave terminal 25 mm', unidad: 'UND', precio_base: null, disponibilidad: 'a confirmar' },
] as never);

describe('revisor: un número solo pasa si lo devolvió la herramienta', () => {
  it('la lista blanca no trae el precio', () => {
    expect(PERMITIDOS).not.toContain('148000');
  });

  // Las frases de plata de la revisora (y de las revisiones anteriores): todas rojas.
  const plata = [
    'Te lo dejo a 9 con 900',
    'Lo dejamos en 120',
    '148 lukas',
    '50 euros',
    '€45',
    '45 bucks each',
    'Vale 148000 la unidad',
    'Son unos 148 mil',
    'Cuesta 1.5 millones',
    'Sale en 150k',
    'Queda en 148 000',
    'Son 2 palos',
    'COP 500',
    'Precio: $90',
    'Sale en ciento cincuenta mil',
    'Vale novecientos',
    'Tiene un 10% de descuento',
    'Descuento del quince por ciento',
    'Cuesta 950',
    '850 cada uno',
    'Te lo dejo en mil',
    // Freno absoluto aunque el número esté en la lista blanca:
    'El FX-1020 queda en 1020 pesos',
    'Hay 12% menos',
    'Te hago un descuento en el FX-1020',
    'Son 12 dólares',
  ];
  for (const t of plata) {
    it(`frena: «${t}»`, () => expect(revisarRespuesta(t, new Map(), PERMITIDOS).ok).toBe(false));
  }

  // Números que la herramienta NO devolvió: se frenan aunque no sean plata.
  const ajenos = [
    'Te llamo al 3001234567',
    'Te llega el 24 de mayo',
    'Para 200 unidades te paso con tu asesor',
    'Abrimos a las 8',
  ];
  for (const t of ajenos) {
    it(`frena (no lo devolvió el catálogo): «${t}»`, () =>
      expect(revisarRespuesta(t, new Map(), PERMITIDOS).ok).toBe(false));
  }

  const normales = [
    'La referencia 1020 está disponible.',
    'El FX-1020 es para orinal.',
    'Hay 12 en existencia.',
    'Es de 1/2 pulgada.',
    'Gasta 3.5 lpf por descarga.',
    'La llave terminal es de 25 mm.',
    'Tenemos dos modelos: el de orinal y la llave.',
    'Te cuento de una referencia que sirve.',
    'Es cien por cien compatible.',
    'Hay mil cosas que te puedo contar del catálogo.',
    '¿Qué referencia buscas?',
    'La disponibilidad de la llave está a confirmar.',
    'Con gusto te ayudo.',
    'Se vende por UND.',
    'Para cotizar, tu asesor te escribe.',
    'El FX-1020 y la 1020 son distintos.',
    '¿Te sirve la de 1/2 pulgada?',
    'Tenemos 12 unidades del FX-1020.',
    'Sí, es para orinal.',
    'No tengo ese dato confirmado.',
    'Una de las dos sirve para sanitario.',
    'Hola, ¿en qué te ayudo hoy?',
    'Es la referencia 1020, llave terminal de 25 mm.',
    'Hay 12 del FX-1020 y la 1020 está a confirmar.',
    'Te lo confirmo en una semana con tu asesor.',
  ];
  for (const t of normales) {
    it(`deja: «${t}»`, () => expect(revisarRespuesta(t, new Map(), PERMITIDOS).ok).toBe(true));
  }

  it('los números del cliente no dan permiso: «sí, en 120» se frena', () => {
    // El cliente preguntó «¿me lo dejas en 120?»; eso no está en `permitidos`.
    expect(revisarRespuesta('Sí, en 120', new Map(), PERMITIDOS).ok).toBe(false);
  });
});
