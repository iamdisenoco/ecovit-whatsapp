/**
 * ECOVIT · Bloque 3: lo que el panel del chat muestra de ECOVIT.
 *
 * La base (migración 0111) enlaza cada `contacts` de WhatsApp por teléfono
 * E.164 con un `contactos` de ECOVIT y su cliente, y deja el resultado en
 * `contacts.enlace_estado` / `enlace_detalle`. `cliente_de_conversacion`
 * devuelve el cliente, el contacto y las oportunidades abiertas, o `null` si
 * quien llama no ve la conversación o no ve el cliente.
 *
 * Este módulo es puro: tipos, formato de pesos, rutas de ECOVIT y la lectura
 * de la función. La pantalla está en `components/inbox/panel-ecovit.tsx`.
 */
import { ecovitUrl } from '@/lib/ecovit/ingreso'

/** Los valores reales del `check` de `contacts.enlace_estado` (0111). */
export const ESTADOS_ENLACE = [
  'enlazado',
  'sin_contacto',
  'varios',
  'telefono_invalido',
  'error',
] as const
export type EstadoEnlace = (typeof ESTADOS_ENLACE)[number]

export interface OportunidadAbierta {
  id: string
  nombre: string
  etapa: string
  valor_proyectado: number | string | null
}

/** Lo que devuelve `cliente_de_conversacion` cuando hay algo que mostrar. */
export interface ClienteDeConversacion {
  cliente: {
    id: string
    nombre: string
    nit: string | null
    vendedor_id: string | null
    vendedor_nombre: string | null
  }
  contacto: { id: string; nombre: string | null; apellido: string | null } | null
  oportunidades: OportunidadAbierta[]
}

/** El resultado de leer la función: o los datos (que pueden ser `null`), o el error real. */
export type LecturaPanel =
  | { ok: true; datos: ClienteDeConversacion | null }
  | { ok: false; error: string }

/** Lo mínimo de `supabase` que usa la lectura (así la prueba no necesita un cliente real). */
export interface ClienteRpc {
  rpc: (
    fn: string,
    args: Record<string, unknown>,
  ) => PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>
}

/**
 * Lee `cliente_de_conversacion`. Nunca lanza: lo que adorna no tumba lo que
 * sirve, y el chat se ve igual si esto falla. El error que devuelve es el de
 * la base (mensaje y código), no uno genérico.
 */
export async function leerClienteDeConversacion(
  supabase: ClienteRpc,
  conversacionId: string,
): Promise<LecturaPanel> {
  try {
    const { data, error } = await supabase.rpc('cliente_de_conversacion', {
      p_conversacion: conversacionId,
    })
    if (error) {
      return { ok: false, error: error.code ? `${error.message} (${error.code})` : error.message }
    }
    return { ok: true, datos: (data as ClienteDeConversacion | null) ?? null }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Pesos colombianos con el formato de ECOVIT (`lib/formatos.ts › pesos`):
 * «$ 1.234.567», sin centavos, con espacio duro después del signo.
 */
export function pesos(valor: number | string | null | undefined): string {
  const n = Number(valor)
  const numero = Number.isFinite(n) ? Math.round(n) : 0
  const signo = numero < 0 ? '−' : ''
  const entero = Math.abs(numero).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.')
  return `$ ${signo}${entero}`
}

/** Los textos de `ETAPAS_OPORTUNIDAD` (ECOVIT, `config/estados.ts`). */
export const ETAPAS_OPORTUNIDAD: Record<string, string> = {
  cliente_identificado: 'Cliente identificado',
  primer_contacto: 'Primer contacto',
  contacto_correcto: 'Contacto correcto',
  necesidad_identificada: 'Necesidad identificada',
  listo_para_cotizar: 'Listo para cotizar',
  cotizacion_enviada: 'Cotización enviada',
  seguimiento_activo: 'Seguimiento activo',
  ganada: 'Ganada',
  perdida: 'Perdida',
}

export function textoEtapa(etapa: string): string {
  return ETAPAS_OPORTUNIDAD[etapa] ?? etapa
}

/**
 * Las rutas de ECOVIT que abre el panel. Todas existen en ECOVIT hoy:
 *  · la ficha del cliente: `/clientes/<id>`;
 *  · sus oportunidades: la misma ficha en la pestaña `?pestana=oportunidades`
 *    (ECOVIT no tiene una página por oportunidad);
 *  · crear oportunidad: el botón «Nueva oportunidad» va arriba en la ficha y
 *    abre un modal; no hay ruta ni parámetro que lo abra, así que se lleva a
 *    la ficha;
 *  · crear contacto: «Nuevo cliente» en `/clientes` (modal, sin parámetro
 *    para el teléfono); el contacto nuevo de un cliente que ya existe se
 *    agrega en su ficha, pestaña Contactos.
 * Sin `NEXT_PUBLIC_ECOVIT_URL` no hay enlaces (`null`).
 */
export function rutasEcovit(base: string | null = ecovitUrl()) {
  if (!base) return null
  const cliente = (id: string) => `${base}/clientes/${encodeURIComponent(id)}`
  return {
    cliente,
    oportunidades: (clienteId: string) => `${cliente(clienteId)}?pestana=oportunidades`,
    crearOportunidad: (clienteId: string) => cliente(clienteId),
    crearContacto: () => `${base}/clientes`,
    clientes: () => `${base}/clientes`,
  }
}
export type RutasEcovit = NonNullable<ReturnType<typeof rutasEcovit>>

/** Lo que el panel va a mostrar, calculado del estado del enlace y la lectura. */
export type VistaPanel =
  | { tipo: 'cargando' }
  | { tipo: 'cliente'; datos: ClienteDeConversacion }
  /** Enlazado, pero la función devolvió null: el cliente no es de su cartera. */
  | { tipo: 'cliente_ajeno' }
  /** Enlazado, pero la lectura falló: se sabe que tiene cliente, no cuál. */
  | { tipo: 'enlazado_sin_leer' }
  | { tipo: 'sin_contacto' }
  | { tipo: 'varios'; detalle: string | null }
  | { tipo: 'telefono_invalido'; detalle: string | null }
  | { tipo: 'error_enlace'; detalle: string | null }

/**
 * Decide qué mostrar. `lectura` null = todavía cargando. Si la lectura
 * falló, la vista sale del estado del enlace (lo que ya está en la fila) y el
 * aviso del error va aparte, sin tumbar nada.
 */
export function vistaPanel(
  estado: string | null | undefined,
  detalle: string | null | undefined,
  lectura: LecturaPanel | null,
): VistaPanel {
  if (lectura?.ok && lectura.datos) return { tipo: 'cliente', datos: lectura.datos }
  const d = detalle ?? null
  switch (estado) {
    case 'varios':
      return { tipo: 'varios', detalle: d }
    case 'telefono_invalido':
      return { tipo: 'telefono_invalido', detalle: d }
    case 'error':
      return { tipo: 'error_enlace', detalle: d }
    case 'enlazado':
      if (lectura === null) return { tipo: 'cargando' }
      // Lectura fallida: no se sabe si es suyo o ajeno; el aviso dice el error.
      return lectura.ok ? { tipo: 'cliente_ajeno' } : { tipo: 'enlazado_sin_leer' }
    default:
      // 'sin_contacto' o null (fila anterior al enlace): no está en Clientes.
      return { tipo: 'sin_contacto' }
  }
}
