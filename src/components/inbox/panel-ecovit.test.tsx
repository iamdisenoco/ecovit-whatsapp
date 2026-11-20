// ECOVIT · Bloque 3. El panel del cliente en el chat, en cada estado del
// enlace (enlazado / sin contacto / varios / error) y cuando la lectura falla.
import { describe, expect, it } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { VistaPanelEcovit } from './panel-ecovit'
import { rutasEcovit, vistaPanel, type ClienteDeConversacion, type LecturaPanel } from '@/lib/ecovit/panel-cliente'

const RUTAS = rutasEcovit('https://comercial.ecovit.test')

const DATOS: ClienteDeConversacion = {
  cliente: { id: 'c-1', nombre: 'Constructora Andina', nit: null, vendedor_id: 'p-1', vendedor_nombre: 'Carlos Pérez' },
  contacto: { id: 'k-1', nombre: 'Ana', apellido: 'Ruiz' },
  oportunidades: [
    { id: 'o-1', nombre: 'Torre 3 · fachada', etapa: 'cotizacion_enviada', valor_proyectado: 1234567 },
    { id: 'o-2', nombre: 'Bodega norte', etapa: 'primer_contacto', valor_proyectado: null },
  ],
}

function pintar(estado: string | null, detalle: string | null, lectura: LecturaPanel | null, rutas = RUTAS) {
  const html = renderToStaticMarkup(
    React.createElement(VistaPanelEcovit, {
      vista: vistaPanel(estado, detalle, lectura),
      aviso: lectura && !lectura.ok ? lectura.error : null,
      rutas,
    }),
  )
  // Texto plano para buscar frases sin depender de las etiquetas.
  return { html, texto: html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').replace(/&#x27;/g, "'") }
}

describe('panel del cliente de ECOVIT', () => {
  it('enlazado: cliente, vendedor, contacto, oportunidades con pesos y los enlaces a ECOVIT', () => {
    const { html, texto } = pintar('enlazado', null, { ok: true, datos: DATOS })
    expect(texto).toContain('Constructora Andina')
    expect(texto).toContain('Vendedor: Carlos Pérez')
    expect(texto).toContain('Contacto: Ana Ruiz')
    expect(texto).toContain('Oportunidades abiertas (2)')
    expect(texto).toContain('Torre 3 · fachada')
    expect(texto).toContain('Cotización enviada')
    expect(html).toContain('$ 1.234.567')
    expect(html).toContain('href="https://comercial.ecovit.test/clientes/c-1"')
    expect(html).toContain('href="https://comercial.ecovit.test/clientes/c-1?pestana=oportunidades"')
    expect(texto).toContain('Ver cliente')
    expect(texto).toContain('Crear oportunidad')
    expect(texto).not.toContain('No se pudo leer')
    // Abre ECOVIT aparte: el chat no se pierde.
    expect(html).toContain('target="_blank"')
  })

  it('enlazado sin oportunidades abiertas lo dice, y deja crear una', () => {
    const { texto } = pintar('enlazado', null, { ok: true, datos: { ...DATOS, oportunidades: [] } })
    expect(texto).toContain('Ninguna abierta.')
    expect(texto).toContain('Crear oportunidad')
  })

  it('ninguno (sin_contacto): no está en Clientes, con «Crear contacto» hacia el alta de ECOVIT', () => {
    const { html, texto } = pintar('sin_contacto', null, { ok: true, datos: null })
    expect(texto).toContain('Este número no está en Clientes.')
    expect(texto).toContain('Crear contacto')
    expect(html).toContain('href="https://comercial.ecovit.test/clientes"')
    expect(texto).not.toContain('Crear oportunidad')
  })

  it('null (sin calcular) se trata como ninguno', () => {
    expect(pintar(null, null, { ok: true, datos: null }).texto).toContain('Este número no está en Clientes.')
  })

  it('varios: lo dice, no elige, y la dirección lo resuelve en ECOVIT', () => {
    const { texto } = pintar('varios', '2 contactos activos de ECOVIT tienen el +573001234567: no se elige ninguno', {
      ok: true,
      datos: null,
    })
    expect(texto).toContain('Este número está en varios clientes.')
    expect(texto).toContain('La dirección lo resuelve en ECOVIT')
    expect(texto).toContain('2 contactos activos de ECOVIT tienen el +573001234567')
    expect(texto).not.toContain('Crear contacto')
  })

  it('error: muestra el enlace_detalle tal cual lo dejó la base', () => {
    const { texto } = pintar('error', 'relation "contactos" does not exist (42P01)', { ok: true, datos: null })
    expect(texto).toContain('No se pudo enlazar este número con Clientes.')
    expect(texto).toContain('relation "contactos" does not exist (42P01)'.replace(/"/g, '&quot;'))
  })

  it('la rpc falla: el panel sale igual, con un aviso pequeño que dice el error real', () => {
    const error = 'Could not find the function public.cliente_de_conversacion(p_conversacion) (PGRST202)'
    const { html, texto } = pintar('sin_contacto', null, { ok: false, error })
    expect(texto).toContain('Este número no está en Clientes.')
    expect(html).toContain('role="status"')
    expect(texto).toContain(`No se pudo leer el cliente de ECOVIT: ${error}`)
  })

  it('la rpc falla con un número enlazado: no inventa un cliente ni se queda cargando', () => {
    const { texto } = pintar('enlazado', null, { ok: false, error: 'fetch failed' })
    expect(texto).toContain('Este número está en Clientes, pero no se pudo traer el cliente.')
    expect(texto).toContain('No se pudo leer el cliente de ECOVIT: fetch failed')
    expect(texto).not.toContain('Buscando el cliente')
  })

  it('testigo: sin error de lectura no sale el aviso', () => {
    expect(pintar('sin_contacto', null, { ok: true, datos: null }).html).not.toContain('role="status"')
  })

  it('enlazado a un cliente ajeno (la base devuelve null): no lo nombra', () => {
    const { texto } = pintar('enlazado', null, { ok: true, datos: null })
    expect(texto).toContain('no está en tu cartera')
    expect(texto).not.toContain('Constructora')
  })

  it('sin NEXT_PUBLIC_ECOVIT_URL: los datos salen, sin enlaces, y lo dice', () => {
    const { html, texto } = pintar('enlazado', null, { ok: true, datos: DATOS }, null)
    expect(texto).toContain('Constructora Andina')
    expect(html).not.toContain('href=')
    expect(texto).toContain('falta NEXT_PUBLIC_ECOVIT_URL')
  })
})
