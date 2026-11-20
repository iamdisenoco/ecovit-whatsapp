// ECOVIT · Bloque 3. `contacts.phone` lo pone solo el webhook (es el único que
// crea números). Cambiarlo en otro lado re-enlaza el chat a otro cliente de
// ECOVIT sin que nadie lo vea —con la sesión o con la clave de servicio—, y
// crear un contacto fuera del webhook es la misma puerta. Esta prueba lee
// `src/` como texto, como `scripts/probar-llamadas-visto.mts` en ECOVIT, y
// falla si alguna cadena `.from('contacts')` hace `insert`/`upsert`, o un
// `update` cuyo objeto nombre `phone` o no se pueda leer (una variable o una
// llave calculada).
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const RAIZ = join(__dirname, '..', '..')
// Bloque 5: el webhook se partió en dos. El de todos los proveedores escribe por su
// almacén (`lib/whatsapp/webhook/almacen-supabase.ts`); el de Meta que traía wacrm
// quedó entero en `app/api/whatsapp/meta/webhook`. Los dos crean contactos.
const WEBHOOKS = [
  'lib/whatsapp/webhook/almacen-supabase.ts',
  'app/api/whatsapp/meta/webhook/route.ts',
]

/**
 * Las llaves calculadas revisadas a mano. Cada una lleva la razón y una
 * comprobación en el texto, para que no se vuelva un permiso mudo.
 */
const CALCULADAS_REVISADAS: Record<string, { porque: string; comprobar: (fuente: string) => boolean }> = {
  'lib/automations/engine.ts': {
    porque: 'update_contact_field: la llave sale de un Set que no incluye phone',
    comprobar: (f) => /new Set\(\['name', 'email', 'company'\]\)/.test(f),
  },
}

function archivos(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    if (statSync(p).isDirectory()) return archivos(p)
    return /\.(ts|tsx)$/.test(n) && !/\.test\.(ts|tsx)$/.test(n) ? [p] : []
  })
}

/** Desde `inicio` (justo después de un `(`), hasta su `)` pareja. */
function hastaCerrar(texto: string, inicio: number): number {
  let n = 1
  for (let i = inicio; i < texto.length; i++) {
    if (texto[i] === '(') n++
    else if (texto[i] === ')' && --n === 0) return i
  }
  return texto.length
}

export interface Escritura {
  metodo: string
  argumento: string
  linea: number
}

/** Las llamadas encadenadas a cada `.from('contacts')` de un texto. */
export function escriturasEnContacts(texto: string): Escritura[] {
  const salida: Escritura[] = []
  const re = /\.from\(\s*['"`]contacts['"`]\s*\)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(texto))) {
    let i = m.index + m[0].length
    for (;;) {
      const sig = /^\s*\.\s*([A-Za-z_]\w*)\s*\(/.exec(texto.slice(i))
      if (!sig) break
      const abre = i + sig[0].length
      const cierra = hastaCerrar(texto, abre)
      if (['insert', 'upsert', 'update'].includes(sig[1])) {
        salida.push({
          metodo: sig[1],
          argumento: texto.slice(abre, cierra),
          linea: texto.slice(0, m.index).split('\n').length,
        })
      }
      i = cierra + 1
    }
  }
  return salida
}

/** null si la escritura está bien; si no, por qué no. */
export function problema(e: Escritura): string | null {
  if (e.metodo !== 'update') return `${e.metodo} en contacts: solo el webhook crea contactos`
  const arg = e.argumento.trim()
  if (!arg.startsWith('{')) return 'update con un objeto que no se puede leer'
  if (/\bphone\b/.test(arg)) return 'update que escribe phone'
  if (/\[[^\]]+\]\s*:/.test(arg)) return 'update con llave calculada'
  return null
}

describe('nadie fuera del webhook crea contactos ni escribe contacts.phone', () => {
  const fuentes = archivos(RAIZ).map((p) => ({ ruta: relative(RAIZ, p), texto: readFileSync(p, 'utf8') }))

  it('lee de verdad el código: encuentra las escrituras de cada webhook', () => {
    for (const ruta of WEBHOOKS) {
      const webhook = fuentes.find((f) => f.ruta === ruta)
      expect(webhook, ruta).toBeDefined()
      const metodos = escriturasEnContacts(webhook!.texto).map((e) => e.metodo)
      expect(metodos, ruta).toContain('insert')
    }
  })

  it('ningún otro archivo de src/', () => {
    const malos: string[] = []
    for (const { ruta, texto } of fuentes) {
      if (WEBHOOKS.includes(ruta)) continue
      for (const e of escriturasEnContacts(texto)) {
        const p = problema(e)
        if (!p) continue
        const revisada = CALCULADAS_REVISADAS[ruta]
        if (p === 'update con llave calculada' && revisada?.comprobar(texto)) continue
        malos.push(`${ruta}:${e.linea} ${p}`)
      }
    }
    expect(malos).toEqual([])
  })

  it('las llaves calculadas permitidas siguen siendo lo que dicen', () => {
    for (const [ruta, { comprobar }] of Object.entries(CALCULADAS_REVISADAS)) {
      const f = fuentes.find((x) => x.ruta === ruta)
      expect(f, ruta).toBeDefined()
      expect(comprobar(f!.texto), ruta).toBe(true)
    }
  })

  it('testigos: cada forma de escribir se detecta, y una lectura o un update limpio no', () => {
    const casos: [string, boolean][] = [
      [`await db.from('contacts').update({ phone: workingPhone }).eq('id', id)`, true],
      [`await db\n  .from("contacts")\n  .update({\n    name: n,\n    phone: p.trim(),\n  })\n  .eq('id', id);`, true],
      [`await db.from('contacts').update({ phone }).eq('id', id)`, true],
      [`supabase.from('contacts').insert(chunk).select()`, true],
      [`supabase.from('contacts').upsert({ id })`, true],
      [`db.from('contacts').update(patch).eq('id', id)`, true],
      [`db.from('contacts').update({ [cfg.field]: v })`, true],
      [`db.from('contacts').select('id, phone').eq('phone', x)`, false],
      [`db.from('contacts').update({ name: n, email: e }).eq('id', id)`, false],
      [`db.from('contact_tags').insert({ phone: 1 })`, false],
    ]
    for (const [codigo, debeFallar] of casos) {
      const encontrados = escriturasEnContacts(codigo).filter((e) => problema(e) !== null)
      expect(encontrados.length > 0, codigo).toBe(debeFallar)
    }
  })
})
