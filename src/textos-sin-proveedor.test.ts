// ============================================================
// La app nunca nombra al proveedor de WhatsApp (Zernio) en lo que ve el
// usuario (Jon, 28-nov). Este barrido lee como TEXTO las cadenas de `src/`
// —literales, plantillas y texto de JSX— y las de `messages/*.json`, y falla
// si alguna que pueda llegar a una pantalla dice «zernio».
//
// No cuenta: comentarios, `console.*` (son registros del servidor), rutas de
// import y códigos sin espacios en minúscula ('zernio', 'x-zernio-signature',
// 'zernio_account_id'), que son nombres de código y no frases.
// ============================================================

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const RAIZ = join(__dirname, '..');

/** ¿Esta cadena es una frase que nombra al proveedor? */
export function nombraAlProveedor(texto: string): boolean {
  // Los nombres de columna o de encabezado (`zernio_account_id`,
  // `x-zernio-signature`) son código aunque vayan en una lista con espacios.
  const sinCodigo = texto.replace(
    /[a-z0-9]*(?:[_-]zernio|zernio[_-])[a-z0-9_-]*/g,
    ''
  );
  if (!/zernio/i.test(sinCodigo)) return false;
  texto = sinCodigo;
  // Una frase (tiene espacios) o el nombre propio escrito para personas.
  return /\s/.test(texto.trim()) || /Zernio|ZERNIO/.test(texto);
}

function dentroDeConsole(nodo: ts.Node): boolean {
  for (let n: ts.Node | undefined = nodo.parent; n; n = n.parent) {
    if (ts.isCallExpression(n)) {
      const f = n.expression;
      if (
        ts.isPropertyAccessExpression(f) &&
        ts.isIdentifier(f.expression) &&
        f.expression.text === 'console'
      )
        return true;
    }
  }
  return false;
}

/** Las cadenas visibles de un archivo que nombran al proveedor. */
export function textosConProveedor(
  codigo: string,
  archivo = 'x.tsx'
): string[] {
  const fuente = ts.createSourceFile(
    archivo,
    codigo,
    ts.ScriptTarget.Latest,
    true,
    archivo.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const hallados: string[] = [];
  const visitar = (n: ts.Node) => {
    if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) return;
    let texto: string | null = null;
    if (
      ts.isStringLiteral(n) ||
      ts.isNoSubstitutionTemplateLiteral(n) ||
      ts.isTemplateHead(n) ||
      ts.isTemplateMiddle(n) ||
      ts.isTemplateTail(n)
    )
      texto = n.text;
    else if (ts.isJsxText(n)) texto = n.text;
    if (texto !== null && nombraAlProveedor(texto) && !dentroDeConsole(n))
      hallados.push(texto.trim());
    ts.forEachChild(n, visitar);
  };
  visitar(fuente);
  return hallados;
}

function archivos(dir: string): string[] {
  const salida: string[] = [];
  for (const nombre of readdirSync(dir)) {
    const ruta = join(dir, nombre);
    if (statSync(ruta).isDirectory()) salida.push(...archivos(ruta));
    else if (
      /\.(ts|tsx)$/.test(nombre) &&
      !/\.test\.tsx?$/.test(nombre) &&
      !nombre.endsWith('.d.ts') &&
      // Muestras de webhooks para las pruebas: nunca llegan a una pantalla.
      !nombre.startsWith('ejemplos-')
    )
      salida.push(ruta);
  }
  return salida;
}

function valores(v: unknown): string[] {
  if (typeof v === 'string') return [v];
  if (v && typeof v === 'object') return Object.values(v).flatMap(valores);
  return [];
}

describe('la app no nombra al proveedor de WhatsApp', () => {
  it('el detector marca lo visible y deja pasar el código (testigo)', () => {
    expect(
      textosConProveedor('const a = <p>Conectado con Zernio</p>;')
    ).toEqual(['Conectado con Zernio']);
    expect(
      textosConProveedor(
        "throw new Error('Falta ZERNIO_API_KEY en el servidor');"
      )
    ).toHaveLength(1);
    expect(
      textosConProveedor('const m = `Zernio respondió ${x}`;', 'x.ts')
    ).toHaveLength(1);
    expect(
      textosConProveedor('const a = <F etiqueta="accountId de Zernio" />;')
    ).toHaveLength(1);
    expect(
      textosConProveedor("const e = 'usa zernio, simulado o meta';")
    ).toHaveLength(1);
    expect(textosConProveedor("const n = { zernio: 'Zernio' };")).toEqual([
      'Zernio',
    ]);
    // Lo que no es para personas.
    expect(
      textosConProveedor(
        [
          "import { x } from './zernio';",
          "if (p === 'zernio') {}",
          "h.get('x-zernio-signature');",
          "console.warn('[historial] zernio respondió 500');",
          '// La pantalla del número con Zernio',
          "const c = 'zernio_account_id';",
          "const cols = 'id, proveedor, zernio_account_id, conectado_desde';",
        ].join('\n'),
        'x.ts'
      )
    ).toEqual([]);
  });

  it('ningún texto de src/ que llegue a una pantalla dice «zernio»', () => {
    const hallados = archivos(join(RAIZ, 'src')).flatMap((ruta) =>
      textosConProveedor(readFileSync(ruta, 'utf8'), ruta).map(
        (t) => `${relative(RAIZ, ruta)}: ${t}`
      )
    );
    expect(hallados).toEqual([]);
  });

  it('ningún catálogo de textos (messages/*.json) dice «zernio»', () => {
    const dir = join(RAIZ, 'messages');
    const hallados = readdirSync(dir)
      .filter((n) => n.endsWith('.json'))
      .flatMap((n) =>
        valores(JSON.parse(readFileSync(join(dir, n), 'utf8')))
          .filter((t) => /zernio/i.test(t))
          .map((t) => `${n}: ${t}`)
      );
    expect(hallados).toEqual([]);
  });
});
