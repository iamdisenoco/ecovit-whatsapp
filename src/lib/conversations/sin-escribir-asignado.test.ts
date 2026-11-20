// ECOVIT · Bloque 4 (0113). El asignado de un chat y la pausa de la IA se
// escriben solo por función: `tomar_conversacion`, `asignar_conversacion`,
// `soltar_conversacion`, `asignar_conversacion_motor`, `pausar_ia_conversacion`,
// `reanudar_ia_conversacion`, `pasar_a_vendedor_wa` y las del celular. Con la
// sesión, la base da 42501; con la clave de servicio, la reja del asignado
// aborta. Esta prueba lee `src/` como texto y falla si alguna cadena
// `.from('conversations')` hace un `insert`/`upsert`/`update` que nombre esas
// columnas, o cuyo objeto no se pueda leer (variable o llave calculada).
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const RAIZ = join(__dirname, '..', '..');

const PROHIBIDAS = [
  'assigned_agent_id',
  'asignado_en',
  'asignado_por',
  'ai_autoreply_disabled',
  'ai_reply_count',
  'ai_handoff_summary',
];

/**
 * Objetos no literales revisados a mano, con una comprobación en el texto
 * para que no se vuelvan un permiso mudo.
 */
const REVISADAS: Record<string, { porque: string; comprobar: (f: string) => boolean }> = {
  'lib/whatsapp/enviar-por-proveedor.ts': {
    porque: 'guardarReferenciaConversacion: llaves calculadas que son las dos columnas del proveedor',
    comprobar: (f) =>
      /\[COLUMNA_REFERENCIA\]: ref\.conversacionId,\s*\[COLUMNA_CUENTA_REFERENCIA\]: ref\.cuentaId/.test(f),
  },
  'lib/whatsapp/webhook/almacen-supabase.ts': {
    porque: 'guardarReferencia: las mismas dos columnas del proveedor',
    comprobar: (f) =>
      /\[COLUMNA_REFERENCIA\]: ref\.conversacionId,\s*\[COLUMNA_CUENTA_REFERENCIA\]: ref\.cuentaId/.test(f) &&
      /export const COLUMNA_REFERENCIA = 'proveedor_conversacion_id'/.test(f),
  },
};

function archivos(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return archivos(p);
    return /\.(ts|tsx)$/.test(n) && !/\.test\.(ts|tsx)$/.test(n) ? [p] : [];
  });
}

function hastaCerrar(texto: string, inicio: number): number {
  let n = 1;
  for (let i = inicio; i < texto.length; i++) {
    if (texto[i] === '(') n++;
    else if (texto[i] === ')' && --n === 0) return i;
  }
  return texto.length;
}

interface Escritura {
  metodo: string;
  argumento: string;
  linea: number;
}

export function escriturasEnConversations(texto: string): Escritura[] {
  const salida: Escritura[] = [];
  const re = /\.from\(\s*['"`]conversations['"`]\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(texto))) {
    let i = m.index + m[0].length;
    for (;;) {
      const sig = /^\s*\.\s*([A-Za-z_]\w*)\s*\(/.exec(texto.slice(i));
      if (!sig) break;
      const abre = i + sig[0].length;
      const cierra = hastaCerrar(texto, abre);
      if (['insert', 'upsert', 'update'].includes(sig[1])) {
        salida.push({
          metodo: sig[1],
          argumento: texto.slice(abre, cierra),
          linea: texto.slice(0, m.index).split('\n').length,
        });
      }
      i = cierra + 1;
    }
  }
  return salida;
}

export function problema(e: Escritura): string | null {
  const arg = e.argumento.trim();
  if (!arg.startsWith('{')) return `${e.metodo} con un objeto que no se puede leer`;
  for (const col of PROHIBIDAS) {
    if (new RegExp(`\\b${col}\\b`).test(arg)) return `${e.metodo} que escribe ${col}`;
  }
  if (/\[[^\]]+\]\s*:/.test(arg)) return `${e.metodo} con llave calculada`;
  return null;
}

describe('el asignado y la pausa de la IA se escriben solo por función', () => {
  const fuentes = archivos(RAIZ).map((p) => ({
    ruta: relative(RAIZ, p),
    texto: readFileSync(p, 'utf8'),
  }));

  it('lee de verdad el código: encuentra escrituras en conversations', () => {
    const total = fuentes.reduce((n, f) => n + escriturasEnConversations(f.texto).length, 0);
    expect(total).toBeGreaterThan(3);
  });

  it('ningún archivo de src/', () => {
    const malos: string[] = [];
    for (const { ruta, texto } of fuentes) {
      for (const e of escriturasEnConversations(texto)) {
        const p = problema(e);
        if (!p) continue;
        if (p.endsWith('llave calculada') && REVISADAS[ruta]?.comprobar(texto)) continue;
        malos.push(`${ruta}:${e.linea} ${p}`);
      }
    }
    expect(malos).toEqual([]);
  });

  it('testigos: cada forma de escribir se detecta, y un update limpio no', () => {
    const casos: [string, boolean][] = [
      [`await db.from('conversations').update({ assigned_agent_id: x }).eq('id', id)`, true],
      [`db\n  .from("conversations")\n  .update({\n    status: 'pending',\n    assigned_agent_id: a,\n  })`, true],
      [`db.from('conversations').update({ ai_autoreply_disabled: true, ai_handoff_summary: s })`, true],
      [`db.from('conversations').update({ ai_reply_count: 0 })`, true],
      [`db.from('conversations').update(convUpdate).eq('id', id)`, true],
      [`db.from('conversations').update({ [k]: v })`, true],
      [`db.from('conversations').insert({ contact_id: c, asignado_por: p })`, true],
      [`db.from('conversations').select('assigned_agent_id').eq('id', id)`, false],
      [`db.from('conversations').update({ status: 'pending', updated_at: t }).eq('id', id)`, false],
    ];
    for (const [codigo, malo] of casos) {
      const hallado = escriturasEnConversations(codigo).some((e) => problema(e) !== null);
      expect(hallado, codigo).toBe(malo);
    }
  });
});
