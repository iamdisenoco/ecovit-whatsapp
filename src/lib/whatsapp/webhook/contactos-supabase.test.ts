import { describe, expect, it } from 'vitest';
import { cambiosDeContacto, type ContactoFila } from './contactos-supabase';

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
