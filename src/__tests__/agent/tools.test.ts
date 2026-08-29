import { executeToolCall, getToolDefinitions } from '../../agent/tools/index.js';
import { ToolContext } from '../../agent/tools/types.js';
import { SupabaseService } from '../../services/supabase.service.js';
import { LlmToolCall } from '../../types/index.js';
import { runWithLanguage } from '../../i18n/index.js';

jest.mock('../../utils/logger');

const BUSINESS_ID = '00000000-0000-0000-0000-000000000001';
const PHONE = '5491155551234';

const CTX: ToolContext = {
  businessId: BUSINESS_ID,
  conversationId: `${BUSINESS_ID}-${PHONE}`,
  phone: PHONE,
  jid: `${PHONE}@s.whatsapp.net`,
  language: 'es',
};

// Abre todos los días de 12:00 a 23:00, para que las reglas bajo prueba sean
// las de ventana/bloqueo y no las de horario.
const OPEN_DAY = { closed: false, shifts: [{ open: '12:00', close: '23:00' }] };
const OPEN_ALWAYS = {
  mon: OPEN_DAY,
  tue: OPEN_DAY,
  wed: OPEN_DAY,
  thu: OPEN_DAY,
  fri: OPEN_DAY,
  sat: OPEN_DAY,
  sun: OPEN_DAY,
};

function call(name: string, args: object = {}): LlmToolCall {
  return { id: 'c1', type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

function run(name: string, args: object = {}) {
  return runWithLanguage('es', () => executeToolCall(call(name, args), CTX));
}

describe('agent tool registry', () => {
  beforeEach(() => {
    jest.restoreAllMocks();

    jest.spyOn(SupabaseService, 'getBusinessById').mockResolvedValue({
      id: BUSINESS_ID,
      name: 'La Parrilla',
      weekly_hours: OPEN_ALWAYS,
      reservation_closing_margin_minutes: 15,
      reservation_opening_margin_minutes: 0,
      future_reservations_blocked_for_date: null,
      address: 'Av. Corrientes 1234',
      city: 'CABA',
      description: null,
    } as any);

    jest.spyOn(SupabaseService, 'getBlockedDates').mockResolvedValue(new Map());
    jest.spyOn(SupabaseService, 'getActiveReservationsByPhone').mockResolvedValue([]);
    jest.spyOn(SupabaseService, 'getActiveEvents').mockResolvedValue([]);
  });

  describe('schema exposto al modelo', () => {
    it('expone cada herramienta una sola vez y con nombre único', () => {
      const names = getToolDefinitions().map((d) => d.function.name);
      expect(new Set(names).size).toBe(names.length);
      expect(names).toEqual(expect.arrayContaining(['resolve_date', 'check_availability', 'create_reservation']));
    });

    it('mantiene un orden estable — reordenar invalidaría el prompt cache', () => {
      expect(getToolDefinitions().map((d) => d.function.name)).toEqual(
        getToolDefinitions().map((d) => d.function.name)
      );
    });
  });

  describe('manejo de errores del modelo', () => {
    it('no lanza ante una herramienta inexistente: se lo informa al modelo', async () => {
      const result = await run('herramienta_inventada');
      expect(result).toMatchObject({ ok: false, error: { code: 'unknown_tool' } });
    });

    it('no lanza ante argumentos que no son JSON válido', async () => {
      const bad: LlmToolCall = {
        id: 'c1',
        type: 'function',
        function: { name: 'resolve_date', arguments: '{no es json' },
      };
      const result = await runWithLanguage('es', () => executeToolCall(bad, CTX));
      expect(result).toMatchObject({ ok: false, error: { code: 'malformed_arguments' } });
    });

    it('convierte una excepción de la herramienta en un resultado, no en un crash', async () => {
      jest.spyOn(SupabaseService, 'getBusinessById').mockRejectedValue(new Error('supabase caído'));
      const result = await run('resolve_date', { dateText: 'mañana' });
      expect(result).toMatchObject({ ok: false, error: { code: 'tool_failed' } });
    });
  });

  describe('resolve_date — reglas de fecha', () => {
    it('resuelve una fecha relativa dentro de la ventana', async () => {
      const result = await run('resolve_date', { dateText: 'mañana' });
      expect(result.ok).toBe(true);
      expect((result.data as any).dateKey).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('rechaza una fecha que no se entiende, sin adivinar', async () => {
      const result = await run('resolve_date', { dateText: 'cuando sea' });
      expect(result).toMatchObject({ ok: false, error: { code: 'unparseable_date' } });
    });

    it('bloquea una fecha marcada por el comercio y devuelve el motivo verbatim', async () => {
      // Se resuelve "mañana" primero para saber qué dateKey bloquear.
      const resolved = await run('resolve_date', { dateText: 'mañana' });
      const dateKey = (resolved.data as any).dateKey;

      jest
        .spyOn(SupabaseService, 'getBlockedDates')
        .mockResolvedValue(new Map([[dateKey, { reason: 'duelo', reasonMessage: 'El local permanecerá cerrado.' }]]));

      const result = await run('resolve_date', { dateText: 'mañana' });
      expect(result).toMatchObject({ ok: false, error: { code: 'date_blocked' } });
      // El motivo lo redactó el comercio: va literal, el modelo no lo reescribe.
      expect(result.verbatim).toContain('El local permanecerá cerrado.');
    });
  });

  describe('check_availability', () => {
    it('exige una dateKey que venga de resolve_date', async () => {
      const result = await run('check_availability', { dateKey: 'el viernes' });
      expect(result).toMatchObject({ ok: false, error: { code: 'invalid_date_key' } });
    });

    it('rechaza un horario fuera del horario de atención y propone alternativa', async () => {
      const resolved = await run('resolve_date', { dateText: 'mañana' });
      const dateKey = (resolved.data as any).dateKey;

      const result = await run('check_availability', { dateKey, timeText: 'a las 3 de la mañana' });
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe('outside_hours');
    });
  });

  describe('create_reservation — reglas duras', () => {
    it('rechaza una cantidad de personas fuera de rango', async () => {
      const result = await run('create_reservation', { customerName: 'Ana', partySize: 99 });
      expect(result).toMatchObject({ ok: false, error: { code: 'invalid_party_size' } });
    });

    it('exige nombre', async () => {
      const result = await run('create_reservation', { customerName: '   ', partySize: 4 });
      expect(result).toMatchObject({ ok: false, error: { code: 'missing_name' } });
    });

    it('no crea una segunda reserva si el cliente ya tiene una activa', async () => {
      jest
        .spyOn(SupabaseService, 'getActiveReservationsByPhone')
        .mockResolvedValue([{ id: 'r1', status: 'WAITING', party_size: 2, scheduled_at: null }] as any);

      const createSpy = jest.spyOn(SupabaseService, 'createReservation');

      const result = await run('create_reservation', { customerName: 'Ana', partySize: 4 });

      expect(result).toMatchObject({ ok: false, error: { code: 'already_has_active_reservation' } });
      expect(createSpy).not.toHaveBeenCalled();
    });
  });

  describe('cancel_reservation — propiedad de la reserva', () => {
    it('no cancela una reserva que no es del cliente que escribe', async () => {
      jest.spyOn(SupabaseService, 'getActiveReservationsByPhone').mockResolvedValue([]);
      const statusSpy = jest.spyOn(SupabaseService, 'updateReservationStatus');

      const result = await run('cancel_reservation', { reservationId: 'reserva-de-otro' });

      expect(result).toMatchObject({ ok: false, error: { code: 'reservation_not_found' } });
      expect(statusSpy).not.toHaveBeenCalled();
    });
  });
});
