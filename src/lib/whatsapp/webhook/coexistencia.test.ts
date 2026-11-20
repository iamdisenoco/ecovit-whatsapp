import { describe, expect, it } from 'vitest';
import {
  MOTIVO_CELULAR,
  debeDespertarPorInactividad,
  ecoDelCelularCallaAlBot,
  entrantePuedeDespertarAlBot,
  esAnteriorALaConexion,
} from './coexistencia';

const CONEXION = '2026-11-20T12:00:00Z';

describe('historia de antes de conectar', () => {
  it('lo anterior a la conexión es historia; lo posterior, no', () => {
    expect(esAnteriorALaConexion('2026-06-01T10:00:00Z', CONEXION)).toBe(true);
    expect(esAnteriorALaConexion('2026-11-20T12:00:01Z', CONEXION)).toBe(false);
  });

  it('sin fecha de conexión falla cerrado: todo es historia', () => {
    expect(esAnteriorALaConexion('2026-06-01T10:00:00Z', null)).toBe(true);
    expect(esAnteriorALaConexion('2026-12-01T10:00:00Z', null)).toBe(true);
    expect(ecoDelCelularCallaAlBot('2026-12-01T10:00:00Z', null)).toBe(true);
  });

  it('un entrante viejo, en espera o marcado como historia no despierta al bot', () => {
    const base = {
      enviadoEn: '2026-11-20T13:00:00Z',
      enEspera: false,
      esHistoria: false,
    };
    expect(entrantePuedeDespertarAlBot(base, CONEXION)).toBe(true);
    expect(
      entrantePuedeDespertarAlBot(
        { ...base, enviadoEn: '2026-10-01T00:00:00Z' },
        CONEXION
      )
    ).toBe(false);
    expect(
      entrantePuedeDespertarAlBot({ ...base, enEspera: true }, CONEXION)
    ).toBe(false);
    expect(
      entrantePuedeDespertarAlBot({ ...base, esHistoria: true }, CONEXION)
    ).toBe(false);
  });

  it('un eco del celular de la historia no calla al bot; uno nuevo sí', () => {
    expect(ecoDelCelularCallaAlBot('2026-08-01T00:00:00Z', CONEXION)).toBe(
      false
    );
    expect(ecoDelCelularCallaAlBot('2026-11-20T12:30:00Z', CONEXION)).toBe(
      true
    );
  });
});

describe('el bot vuelve solo si el cliente llevaba 24 h sin escribir', () => {
  const callado = {
    ai_autoreply_disabled: true,
    ai_handoff_summary: MOTIVO_CELULAR,
    assigned_agent_id: null,
    last_inbound_at: '2026-11-19T10:00:00Z',
  };

  it('24 h o más: vuelve', () => {
    expect(debeDespertarPorInactividad(callado, '2026-11-20T10:00:00Z')).toBe(
      true
    );
  });

  it('menos de 24 h: sigue callado', () => {
    expect(debeDespertarPorInactividad(callado, '2026-11-20T09:59:59Z')).toBe(
      false
    );
  });

  it('si lo calló una persona («Tomar»), o alguien lo tiene, no vuelve', () => {
    expect(
      debeDespertarPorInactividad(
        { ...callado, ai_handoff_summary: 'Lo tomó Carlos' },
        '2026-11-25T00:00:00Z'
      )
    ).toBe(false);
    expect(
      debeDespertarPorInactividad(
        { ...callado, assigned_agent_id: 'u-1' },
        '2026-11-25T00:00:00Z'
      )
    ).toBe(false);
  });

  it('si no estaba callado, no hay nada que despertar', () => {
    expect(
      debeDespertarPorInactividad(
        { ...callado, ai_autoreply_disabled: false },
        '2026-11-25T00:00:00Z'
      )
    ).toBe(false);
  });
});
