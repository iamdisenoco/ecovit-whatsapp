import { describe, expect, it } from 'vitest';
import {
  buscarOCrearContactoSupabase,
  cambiosDeContacto,
  nombreParaCompletar,
  type ContactoFila,
} from './contactos-supabase';

const identidad = {
  telefono: '573001112233',
  waUserId: 'CO.1',
  waParentUserId: null,
  waUsername: null,
  nombre: 'Nombre de WhatsApp',
};

const contacto = (name: string | null): ContactoFila => ({
  id: 'c1',
  phone: '573001112233',
  name,
  wa_user_id: 'CO.1',
  wa_parent_user_id: null,
  wa_username: null,
});

describe('cambiosDeContacto: el nombre', () => {
  it('nunca pisa un nombre puesto a mano', () => {
    expect(
      cambiosDeContacto(contacto('Doña Marta (obra 4)'), identidad)
    ).toEqual({});
  });

  it('lo pone si no había nombre', () => {
    expect(cambiosDeContacto(contacto(''), identidad).name).toBe(
      'Nombre de WhatsApp'
    );
    expect(cambiosDeContacto(contacto(null), identidad).name).toBe(
      'Nombre de WhatsApp'
    );
  });

  it('lo pone si el nombre era el relleno (el teléfono o el BSUID)', () => {
    expect(cambiosDeContacto(contacto('573001112233'), identidad).name).toBe(
      'Nombre de WhatsApp'
    );
    expect(
      cambiosDeContacto(contacto('+57 300 111 2233'), identidad).name
    ).toBe('Nombre de WhatsApp');
    expect(cambiosDeContacto(contacto('CO.1'), identidad).name).toBe(
      'Nombre de WhatsApp'
    );
  });
});

describe('cambiosDeContacto: el origen del nombre', () => {
  it('un teléfono que escribió una persona no es relleno: el perfil no lo pisa', () => {
    expect(
      cambiosDeContacto(
        { ...contacto('573001112233'), nombre_origen: 'persona' },
        identidad
      ).name
    ).toBeUndefined();
    // Testigo: el mismo teléfono sin origen sí es relleno.
    expect(cambiosDeContacto(contacto('573001112233'), identidad).name).toBe(
      'Nombre de WhatsApp'
    );
  });

  it('el nombre del perfil tampoco pisa uno con letras de origen nulo', () => {
    expect(
      cambiosDeContacto(
        { ...contacto('Juan Perfil'), nombre_origen: null },
        identidad
      ).name
    ).toBeUndefined();
  });

  it('el nombre del perfil (un mensaje) no pisa el que puso la agenda', () => {
    expect(
      cambiosDeContacto(
        { ...contacto('Ana de la agenda'), nombre_origen: 'agenda' },
        identidad
      ).name
    ).toBeUndefined();
  });
});

describe('nombreParaCompletar: el origen del nombre', () => {
  it('nunca sobre uno de una persona, aunque sea el teléfono', () => {
    expect(
      nombreParaCompletar(
        { ...contacto('573001112233'), nombre_origen: 'persona' },
        'Nombre de la agenda'
      )
    ).toBeNull();
    // Testigo: el mismo relleno sin origen sí se completa.
    expect(
      nombreParaCompletar(contacto('573001112233'), 'Nombre de la agenda')
    ).toBe('Nombre de la agenda');
  });
});

describe('buscarOCrearContactoSupabase: lee el origen sin sumar pedidos', () => {
  it('por BSUID trae nombre_origen en la misma consulta y no pisa el teléfono que puso una persona', async () => {
    const fila = {
      id: 'c1',
      phone: '573001112233',
      name: '573001112233',
      nombre_origen: 'persona',
      wa_user_id: 'CO.1',
      wa_parent_user_id: null,
      wa_username: null,
    };
    const consultas: string[] = [];
    const updates: unknown[] = [];
    const db = {
      from: () => {
        let columnas = '';
        const q: Record<string, unknown> = {};
        q.select = (c: string) => {
          columnas = c;
          consultas.push(c);
          return q;
        };
        q.eq = () => q;
        q.update = (cambios: unknown) => {
          updates.push(cambios);
          return q;
        };
        // Como PostgREST: solo las columnas pedidas.
        q.maybeSingle = async () => {
          const pedidas = columnas.split(',').map((x) => x.trim());
          return {
            data: Object.fromEntries(
              Object.entries(fila).filter(([k]) => pedidas.includes(k))
            ),
            error: null,
          };
        };
        q.then = (ok: (v: unknown) => unknown) =>
          Promise.resolve({ data: null, error: null }).then(ok);
        return q;
      },
    };
    const r = await buscarOCrearContactoSupabase(
      db as never,
      { accountId: 'a', usuarioId: 'u', conectadoDesde: null },
      { ...identidad, nombre: 'Perfil de WhatsApp' }
    );
    expect(r).toEqual({ contactoId: 'c1', creado: false });
    // Una sola lectura, con el origen adentro.
    expect(consultas).toHaveLength(1);
    expect(consultas[0]).toContain('nombre_origen');
    // No hubo nada que cambiar: ni el nombre ni nada más.
    expect(updates).toHaveLength(0);
  });
});
