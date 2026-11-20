import { describe, expect, it } from 'vitest'

import {
  ESTADOS_ENLACE,
  leerClienteDeConversacion,
  pesos,
  rutasEcovit,
  vistaPanel,
  type ClienteDeConversacion,
  type ClienteRpc,
} from './panel-cliente'

const DATOS: ClienteDeConversacion = {
  cliente: { id: 'c-1', nombre: 'Constructora Andina', nit: '900123456', vendedor_id: 'p-1', vendedor_nombre: 'Carlos' },
  contacto: { id: 'k-1', nombre: 'Ana', apellido: 'Ruiz' },
  oportunidades: [{ id: 'o-1', nombre: 'Torre 3', etapa: 'cotizacion_enviada', valor_proyectado: 1234567 }],
}

function rpc(respuesta: { data: unknown; error: { message: string; code?: string } | null } | Error): ClienteRpc & { llamadas: unknown[] } {
  const llamadas: unknown[] = []
  return {
    llamadas,
    rpc: async (fn, args) => {
      llamadas.push([fn, args])
      if (respuesta instanceof Error) throw respuesta
      return respuesta
    },
  }
}

describe('pesos: el formato de ECOVIT', () => {
  it('pone puntos de miles, sin centavos y con espacio duro', () => {
    expect(pesos(1234567)).toBe('$ 1.234.567')
    expect(pesos('72000.49')).toBe('$ 72.000')
    expect(pesos(0)).toBe('$ 0')
    expect(pesos(-5000)).toBe('$ −5.000')
    expect(pesos(999)).toBe('$ 999')
  })
})

describe('leerClienteDeConversacion', () => {
  it('llama la función con p_conversacion', async () => {
    const sb = rpc({ data: DATOS, error: null })
    expect(await leerClienteDeConversacion(sb, 'conv-1')).toEqual({ ok: true, datos: DATOS })
    expect(sb.llamadas).toEqual([['cliente_de_conversacion', { p_conversacion: 'conv-1' }]])
  })

  it('null de la base es «no hay o no lo ves», no un error', async () => {
    expect(await leerClienteDeConversacion(rpc({ data: null, error: null }), 'c')).toEqual({ ok: true, datos: null })
  })

  it('devuelve el error real de la base, con su código', async () => {
    const r = await leerClienteDeConversacion(
      rpc({ data: null, error: { message: 'permission denied for function cliente_de_conversacion', code: '42501' } }),
      'c',
    )
    expect(r).toEqual({ ok: false, error: 'permission denied for function cliente_de_conversacion (42501)' })
  })

  it('no lanza si la red se cae: lo devuelve como error', async () => {
    const r = await leerClienteDeConversacion(rpc(new Error('fetch failed')), 'c')
    expect(r).toEqual({ ok: false, error: 'fetch failed' })
  })
})

describe('vistaPanel', () => {
  const okNull = { ok: true as const, datos: null }
  const falla = { ok: false as const, error: 'x' }

  it('con datos muestra el cliente, sea cual sea el estado guardado', () => {
    expect(vistaPanel('enlazado', null, { ok: true, datos: DATOS })).toEqual({ tipo: 'cliente', datos: DATOS })
  })

  it('enlazado: carga, luego cliente ajeno si la base devuelve null, o «sin leer» si falla', () => {
    expect(vistaPanel('enlazado', null, null).tipo).toBe('cargando')
    expect(vistaPanel('enlazado', null, okNull).tipo).toBe('cliente_ajeno')
    expect(vistaPanel('enlazado', null, falla).tipo).toBe('enlazado_sin_leer')
  })

  it('sin_contacto y null (fila anterior al enlace) son «no está en Clientes»', () => {
    expect(vistaPanel('sin_contacto', null, okNull).tipo).toBe('sin_contacto')
    expect(vistaPanel(null, null, okNull).tipo).toBe('sin_contacto')
    expect(vistaPanel(undefined, null, null).tipo).toBe('sin_contacto')
  })

  it('varios, teléfono inválido y error llevan el detalle de la base aunque la lectura falle', () => {
    expect(vistaPanel('varios', '2 contactos activos', falla)).toEqual({ tipo: 'varios', detalle: '2 contactos activos' })
    expect(vistaPanel('telefono_invalido', '«abc»', okNull)).toEqual({ tipo: 'telefono_invalido', detalle: '«abc»' })
    expect(vistaPanel('error', 'division by zero (22012)', falla)).toEqual({
      tipo: 'error_enlace',
      detalle: 'division by zero (22012)',
    })
  })

  it('cubre cada valor del check de la 0111 sin caer en «sin contacto» por descuido', () => {
    const tipos = ESTADOS_ENLACE.map((e) => vistaPanel(e, 'd', okNull).tipo)
    expect(tipos).toEqual(['cliente_ajeno', 'sin_contacto', 'varios', 'telefono_invalido', 'error_enlace'])
  })
})

describe('rutasEcovit', () => {
  it('arma las rutas de ECOVIT sobre la raíz', () => {
    const r = rutasEcovit('https://comercial.ecovit.test')!
    expect(r.cliente('c-1')).toBe('https://comercial.ecovit.test/clientes/c-1')
    expect(r.oportunidades('c-1')).toBe('https://comercial.ecovit.test/clientes/c-1?pestana=oportunidades')
    expect(r.crearOportunidad('c-1')).toBe('https://comercial.ecovit.test/clientes/c-1')
    expect(r.crearContacto()).toBe('https://comercial.ecovit.test/clientes')
  })

  it('sin raíz no hay enlaces', () => {
    expect(rutasEcovit(null)).toBeNull()
  })
})
