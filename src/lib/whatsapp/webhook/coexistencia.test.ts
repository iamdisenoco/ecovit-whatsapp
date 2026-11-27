import { describe, expect, it } from 'vitest';
import {
  HORAS_CELULAR,
  MOTIVO_CELULAR,
  debeVolverElBot,
  horaBogota,
  vueltaVisible,
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

describe(`el bot vuelve solo ${HORAS_CELULAR} h después de la última respuesta del celular`, () => {
  const callado = {
    ai_autoreply_disabled: true,
    ai_handoff_summary: MOTIVO_CELULAR,
    assigned_agent_id: null,
  };
  const ECO = '2026-11-20T10:00:00Z';

  it('las horas están en una sola constante: 4', () => {
    expect(HORAS_CELULAR).toBe(4);
  });

  it('cliente a las 4 h exactas: vuelve', () => {
    expect(debeVolverElBot(callado, ECO, '2026-11-20T14:00:00Z')).toBe(true);
  });

  it('cliente a las 3 h 59: sigue callado', () => {
    expect(debeVolverElBot(callado, ECO, '2026-11-20T13:59:00Z')).toBe(false);
    expect(debeVolverElBot(callado, ECO, '2026-11-20T13:59:59.999Z')).toBe(
      false
    );
  });

  it('sin eco del celular no vuelve (falla hacia la persona)', () => {
    expect(debeVolverElBot(callado, null, '2026-11-30T00:00:00Z')).toBe(false);
  });

  it('si lo calló una persona («Tomar»), o alguien lo tiene, no vuelve', () => {
    expect(
      debeVolverElBot(
        { ...callado, ai_handoff_summary: 'Lo tomó Carlos' },
        ECO,
        '2026-11-25T00:00:00Z'
      )
    ).toBe(false);
    expect(
      debeVolverElBot(
        { ...callado, assigned_agent_id: 'u-1' },
        ECO,
        '2026-11-25T00:00:00Z'
      )
    ).toBe(false);
  });

  it('si no estaba callado, no hay nada que despertar', () => {
    expect(
      debeVolverElBot(
        { ...callado, ai_autoreply_disabled: false },
        ECO,
        '2026-11-25T00:00:00Z'
      )
    ).toBe(false);
  });
});

describe('lo que la bandeja dice de la vuelta del bot (hora de Bogotá)', () => {
  const ECO = '2026-11-20T15:30:00Z'; // 10:30 en Bogotá

  it('antes de las 4 h: la hora de Bogotá (UTC−5), en 24 h', () => {
    expect(vueltaVisible(ECO, Date.parse('2026-11-20T16:00:00Z'))).toEqual({
      tipo: 'a_las',
      hora: '14:30',
    });
  });

  it('cruza la medianoche de Bogotá sin perder la hora', () => {
    // 22:15 en Bogotá → vuelve a las 02:15.
    expect(
      vueltaVisible('2026-11-21T03:15:00Z', Date.parse('2026-11-21T03:20:00Z'))
    ).toEqual({ tipo: 'a_las', hora: '02:15' });
  });

  it('a las 4 h o después: contesta el próximo mensaje', () => {
    expect(vueltaVisible(ECO, Date.parse('2026-11-20T19:30:00Z'))).toEqual({
      tipo: 'proximo_mensaje',
    });
    expect(vueltaVisible(ECO, Date.parse('2026-11-20T19:29:59Z'))).toEqual({
      tipo: 'a_las',
      hora: '14:30',
    });
  });

  it('sin eco: sin hora', () => {
    expect(vueltaVisible(null, Date.now())).toEqual({ tipo: 'sin_hora' });
    expect(vueltaVisible(undefined, Date.now())).toEqual({ tipo: 'sin_hora' });
  });

  it('horaBogota da HH:MM con cero a la izquierda', () => {
    expect(horaBogota(Date.parse('2026-11-20T14:05:00Z'))).toBe('09:05');
    expect(horaBogota(Date.parse('2026-11-20T05:00:00Z'))).toBe('00:00');
  });
});
