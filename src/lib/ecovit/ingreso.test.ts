import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  enLista,
  mensajeErrorIngreso,
  sesionCompartida,
  urlSalida,
  urlSinPerfil,
  urlSinSesion,
  volverSeguro,
} from './ingreso'

const ENV = { ...process.env }

beforeEach(() => {
  process.env.NEXT_PUBLIC_ECOVIT_URL = 'https://comercial.ecovit.test'
  delete process.env.NEXT_PUBLIC_COOKIE_DOMAIN
})
afterEach(() => {
  process.env = { ...ENV }
})

describe('a dónde se manda a quien no tiene sesión', () => {
  it('sin COOKIE_DOMAIN: /ingresar propio con volver relativo', () => {
    expect(sesionCompartida()).toBe(false)
    expect(urlSinSesion('https://wa.vercel.app/inbox?c=1')).toBe('/ingresar?volver=%2Finbox%3Fc%3D1')
    expect(urlSinPerfil()).toBe('/ingresar?motivo=baja')
    expect(urlSalida()).toBe('/ingresar')
  })

  it('sin COOKIE_DOMAIN y desde /ingresar no arma volver (sin vueltas en redondo)', () => {
    expect(urlSinSesion('https://wa.vercel.app/ingresar?volver=%2Finbox')).toBe('/ingresar')
  })

  it('con COOKIE_DOMAIN: el ingreso de ECOVIT con volver = URL completa', () => {
    process.env.NEXT_PUBLIC_COOKIE_DOMAIN = '.ecovit.test'
    expect(sesionCompartida()).toBe(true)
    const u = new URL(urlSinSesion('https://wa.ecovit.test/inbox?c=1'))
    expect(u.origin + u.pathname).toBe('https://comercial.ecovit.test/ingresar')
    expect(u.searchParams.get('volver')).toBe('https://wa.ecovit.test/inbox?c=1')
    expect(urlSinPerfil()).toBe('https://comercial.ecovit.test/ingresar')
    expect(urlSalida()).toBe('https://comercial.ecovit.test/ingresar')
  })

  it('con COOKIE_DOMAIN y sin ECOVIT_URL: /sin-sesion', () => {
    process.env.NEXT_PUBLIC_COOKIE_DOMAIN = '.ecovit.test'
    delete process.env.NEXT_PUBLIC_ECOVIT_URL
    expect(urlSinSesion('https://wa.ecovit.test/inbox')).toBe('/sin-sesion')
    expect(urlSalida()).toBe('/sin-sesion')
  })

  it('un COOKIE_DOMAIN en blanco cuenta como no definido', () => {
    process.env.NEXT_PUBLIC_COOKIE_DOMAIN = '   '
    expect(sesionCompartida()).toBe(false)
  })
})

describe('volverSeguro', () => {
  it('acepta rutas relativas de esta app', () => {
    expect(volverSeguro('/inbox')).toBe('/inbox')
    expect(volverSeguro('/inbox?c=1#m')).toBe('/inbox?c=1#m')
    expect(volverSeguro('/contacts/123')).toBe('/contacts/123')
  })

  it.each([
    'https://evil.com/inbox',
    'http://evil.com',
    '//evil.com',
    '/\\evil.com',
    '\\\\evil.com',
    'javascript:alert(1)',
    'inbox',
    '/\t/evil.com',
    '/\n/evil.com',
    '',
  ])('rechaza %j y cae a /inbox', (pedida) => {
    expect(volverSeguro(pedida)).toBe('/inbox')
  })

  it('null o ausente cae al destino por defecto', () => {
    expect(volverSeguro(null)).toBe('/inbox')
    expect(volverSeguro(undefined, '/x')).toBe('/x')
  })

  it('no vuelve a /ingresar, pero /ingresarx es otra ruta', () => {
    expect(volverSeguro('/ingresar')).toBe('/inbox')
    expect(volverSeguro('/ingresar?volver=/inbox')).toBe('/inbox')
    expect(volverSeguro('/ingresar/x')).toBe('/inbox')
    expect(volverSeguro('/ingresarx')).toBe('/ingresarx')
  })
})

describe('enLista compara por segmento', () => {
  it('/ingresar y sus hijas sí; /ingresarx no', () => {
    expect(enLista('/ingresar', ['/ingresar'])).toBe(true)
    expect(enLista('/ingresar/algo', ['/ingresar'])).toBe(true)
    expect(enLista('/ingresarx', ['/ingresar'])).toBe(false)
  })
})

describe('mensajeErrorIngreso', () => {
  it('no muestra el error crudo', () => {
    expect(mensajeErrorIngreso('Invalid login credentials')).toBe('El correo o la contraseña no coinciden.')
    expect(mensajeErrorIngreso('fetch failed')).toBe('No pudimos iniciar tu sesión. Intenta de nuevo en un momento.')
    expect(mensajeErrorIngreso(null)).toBe('No pudimos iniciar tu sesión. Intenta de nuevo en un momento.')
  })
})
