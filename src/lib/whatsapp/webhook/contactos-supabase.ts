// ============================================================
// Buscar o crear el contacto de WhatsApp (con la clave de servicio). Es, junto
// con la ruta de Meta, el ÚNICO código que crea contactos o les pone teléfono:
// lo vigila `lib/contacts/sin-escribir-telefono.test.ts`.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  findExistingContact,
  isUniqueViolation,
  pickBestPhoneMatch,
} from '@/lib/contacts/dedupe';
import { normalizePhone, phoneVariants } from '../phone-utils';
import type { IdentidadRemitente } from '../proveedor/tipos';
import { ErrorAlmacen, type Inquilino } from './almacen';

const COLUMNAS_CONTACTO =
  'id, phone, name, wa_user_id, wa_parent_user_id, wa_username';

export interface ContactoFila {
  id: string;
  phone: string | null;
  name: string | null;
  wa_user_id: string | null;
  wa_parent_user_id: string | null;
  wa_username: string | null;
}

async function contactoPorBsuid(
  db: SupabaseClient,
  accountId: string,
  waUserId: string
): Promise<ContactoFila | null> {
  const { data, error } = await db
    .from('contacts')
    .select(COLUMNAS_CONTACTO)
    .eq('account_id', accountId)
    .eq('wa_user_id', waUserId)
    .maybeSingle();
  if (error)
    throw new ErrorAlmacen(
      `No se pudo buscar el contacto por BSUID: ${error.message}`
    );
  return (data as ContactoFila | null) ?? null;
}

async function contactoPorTelefono(
  db: SupabaseClient,
  accountId: string,
  telefono: string
): Promise<ContactoFila | null> {
  const c = await findExistingContact(db, accountId, telefono);
  return c ? (c as unknown as ContactoFila) : null;
}

/** ¿El nombre es de relleno (el teléfono o el BSUID que se puso al crearlo)? */
function sinNombre(c: ContactoFila): boolean {
  const n = (c.name ?? '').trim();
  if (!n) return true;
  const digitos = n.replace(/\D/g, '');
  return (
    (!!digitos && digitos === normalizePhone(c.phone ?? '')) ||
    n === c.wa_user_id ||
    n === c.wa_username
  );
}

/**
 * ¿Sirve como nombre? Un teléfono escrito como nombre (`+57 300 111 2233`, lo
 * que el proveedor pone cuando la agenda no tiene uno) no sirve.
 */
export function nombreUtil(nombre: string | null | undefined): string | null {
  const n = (nombre ?? '').trim();
  if (!n) return null;
  if (/^[\d\s+().-]+$/.test(n)) return null;
  return n;
}

/**
 * La regla del nombre, la única: el nombre que hay que poner, o `null` si no
 * se toca. Solo cuando el contacto no tiene un nombre de verdad (vacío o el
 * relleno del teléfono/BSUID), y nunca un teléfono como nombre. Nunca pisa uno
 * puesto a mano. La usan el webhook, el historial y `contact.updated`.
 */
export function nombreParaCompletar(
  existente: ContactoFila,
  candidato: string | null | undefined
): string | null {
  const nombre = nombreUtil(candidato);
  if (!nombre || nombre === existente.name || !sinNombre(existente))
    return null;
  return nombre;
}

/**
 * Lo que se completa en un contacto que ya existe. Solo lo que falta o lo que
 * el proveedor sí dijo. El nombre solo se pone si no había uno de verdad: nunca
 * pisa el que alguien escribió a mano. El teléfono se llena solo si estaba
 * vacío: nunca se reescribe (re-enlazaría el chat a otro cliente de ECOVIT,
 * bloque 3).
 */
export function cambiosDeContacto(
  existente: ContactoFila,
  identidad: IdentidadRemitente
): Record<string, string> {
  const cambios: Record<string, string> = {};
  const nombre = nombreParaCompletar(
    existente,
    identidad.nombre || identidad.waUsername
  );
  if (nombre) cambios.name = nombre;
  if (identidad.waUserId && identidad.waUserId !== existente.wa_user_id)
    cambios.wa_user_id = identidad.waUserId;
  if (
    identidad.waParentUserId &&
    identidad.waParentUserId !== existente.wa_parent_user_id
  ) {
    cambios.wa_parent_user_id = identidad.waParentUserId;
  }
  if (identidad.waUsername && identidad.waUsername !== existente.wa_username) {
    cambios.wa_username = identidad.waUsername;
  }
  if (identidad.telefono && !normalizePhone(existente.phone ?? ''))
    cambios.phone = identidad.telefono;
  return cambios;
}

export async function buscarOCrearContactoSupabase(
  db: SupabaseClient,
  inq: Inquilino,
  identidad: IdentidadRemitente
): Promise<{ contactoId: string; creado: boolean }> {
  let existente = identidad.waUserId
    ? await contactoPorBsuid(db, inq.accountId, identidad.waUserId)
    : null;
  if (!existente && identidad.telefono)
    existente = await contactoPorTelefono(
      db,
      inq.accountId,
      identidad.telefono
    );

  if (existente) {
    const cambios = cambiosDeContacto(existente, identidad);
    if (Object.keys(cambios).length > 0) {
      const { error } = await db
        .from('contacts')
        .update({ ...cambios, updated_at: new Date().toISOString() })
        .eq('id', existente.id);
      // Un BSUID que otra entrega ya tomó: no es fatal, el mensaje es de este contacto.
      if (error)
        console.error(
          '[webhook] no se pudo completar la identidad del contacto:',
          error.message
        );
    }
    return { contactoId: existente.id, creado: false };
  }

  const nombre =
    identidad.nombre ||
    identidad.waUsername ||
    identidad.telefono ||
    identidad.waUserId ||
    '';
  const { data, error } = await db
    .from('contacts')
    .insert({
      account_id: inq.accountId,
      user_id: inq.usuarioId,
      // `phone` es NOT NULL: un remitente solo con BSUID queda con '' (índice parcial).
      phone: identidad.telefono,
      name: nombre,
      wa_user_id: identidad.waUserId,
      wa_parent_user_id: identidad.waParentUserId,
      wa_username: identidad.waUsername,
    })
    .select('id')
    .single();
  if (error) {
    // Carrera con otra entrega que lo creó primero: se usa el que quedó.
    if (isUniqueViolation(error)) {
      const ganador =
        (identidad.waUserId &&
          (await contactoPorBsuid(db, inq.accountId, identidad.waUserId))) ||
        (identidad.telefono &&
          (await contactoPorTelefono(db, inq.accountId, identidad.telefono))) ||
        null;
      if (ganador) return { contactoId: ganador.id, creado: false };
    }
    throw new ErrorAlmacen(`No se pudo crear el contacto: ${error.message}`);
  }
  return { contactoId: data.id as string, creado: true };
}

/** Teléfonos por consulta: cada uno lleva sus variantes y todo va en la URL. */
const TELEFONOS_POR_CONSULTA = 25;

/**
 * Pone el nombre de la agenda a los contactos que YA existen, con la regla de
 * `nombreParaCompletar`. Nunca crea un contacto. El `update` es condicional al
 * nombre que se leyó: si alguien lo escribió a mano en el medio, no se pisa.
 * Devuelve cuántos nombres se pusieron.
 */
export async function completarNombresSupabase(
  db: SupabaseClient,
  inq: Inquilino,
  pares: Array<{ telefono: string; nombre: string }>
): Promise<number> {
  const utiles = pares
    .map((p) => ({ telefono: normalizePhone(p.telefono), nombre: p.nombre }))
    .filter((p) => p.telefono && nombreUtil(p.nombre));
  let completados = 0;
  for (let i = 0; i < utiles.length; i += TELEFONOS_POR_CONSULTA) {
    const tramo = utiles.slice(i, i + TELEFONOS_POR_CONSULTA);
    const variantes = [
      ...new Set(tramo.flatMap((p) => phoneVariants(p.telefono))),
    ];
    const { data, error } = await db
      .from('contacts')
      .select(COLUMNAS_CONTACTO)
      .eq('account_id', inq.accountId)
      .in('phone_normalized', variantes);
    if (error)
      throw new ErrorAlmacen(
        `No se pudieron buscar los contactos por teléfono: ${error.message}`
      );
    const candidatos = ((data ?? []) as ContactoFila[]).map((c) => ({
      ...c,
      phone: c.phone ?? '',
    }));
    for (const p of tramo) {
      const existente = pickBestPhoneMatch(candidatos, p.telefono);
      if (!existente) continue;
      const nombre = nombreParaCompletar(existente, p.nombre);
      if (!nombre) continue;
      let q = db
        .from('contacts')
        .update({ name: nombre, updated_at: new Date().toISOString() })
        .eq('id', existente.id);
      // Solo si sigue con el nombre que se leyó: no pisa lo escrito en el medio.
      q =
        existente.name === null
          ? q.is('name', null)
          : q.eq('name', existente.name);
      const { data: cambiados, error: errUpd } = await q.select('id');
      if (errUpd) {
        console.error(
          '[contactos] no se pudo completar el nombre:',
          errUpd.message
        );
        continue;
      }
      if (cambiados && cambiados.length > 0) {
        completados++;
        existente.name = nombre;
      }
    }
  }
  return completados;
}
