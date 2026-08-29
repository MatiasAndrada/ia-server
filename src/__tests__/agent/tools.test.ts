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

  describe('modo sombra (dryRun) — ninguna herramienta escribe', () => {
    const SHADOW_CTX: ToolContext = { ...CTX, dryRun: true };

    function runShadow(name: string, args: object = {}) {
      return runWithLanguage('es', () => executeToolCall(call(name, args), SHADOW_CTX));
    }

    it('create_reservation no toca la base pero simula el alta', async () => {
      const createSpy = jest.spyOn(SupabaseService, 'createReservation');

      const result = await runShadow('create_reservation', { customerName: 'Ana', partySize: 4 });

      expect(createSpy).not.toHaveBeenCalled();
      expect(result.ok).toBe(true);
      // Simula el éxito para que el modelo cierre el turno y sea comparable.
      expect((result.data as any).dryRun).toBe(true);
    });

    it('cancel_reservation no cancela la reserva real', async () => {
      jest
        .spyOn(SupabaseService, 'getActiveReservationsByPhone')
        .mockResolvedValue([{ id: 'r1', status: 'WAITING', party_size: 2, scheduled_at: null }] as any);
      const statusSpy = jest.spyOn(SupabaseService, 'updateReservationStatus');

      const result = await runShadow('cancel_reservation', { reservationId: 'r1' });

      expect(statusSpy).not.toHaveBeenCalled();
      expect((result.data as any).dryRun).toBe(true);
    });

    it('modify_reservation no actualiza nada', async () => {
      jest
        .spyOn(SupabaseService, 'getActiveReservationsByPhone')
        .mockResolvedValue([{ id: 'r1', status: 'WAITING', party_size: 2, scheduled_at: null }] as any);
      const partySpy = jest.spyOn(SupabaseService, 'updateReservationPartySize');

      await runShadow('modify_reservation', { reservationId: 'r1', partySize: 6 });

      expect(partySpy).not.toHaveBeenCalled();
    });

    it('update_customer_name no pisa el nombre real del cliente', async () => {
      const nameSpy = jest.spyOn(SupabaseService, 'updateCustomerNameByPhone');

      await runShadow('update_customer_name', { name: 'Nombre Fantasma' });

      expect(nameSpy).not.toHaveBeenCalled();
    });

    it('set_language no cambia la preferencia real', async () => {
      const langSpy = jest.spyOn(SupabaseService, 'updateCustomerLanguage');

      await runShadow('set_language', { language: 'en' });

      expect(langSpy).not.toHaveBeenCalled();
    });

    it('las herramientas de lectura siguen funcionando igual', async () => {
      const result = await runShadow('resolve_date', { dateText: 'mañana' });
      expect(result.ok).toBe(true);
    });
  });

  describe('show_event_details — fotos del evento', () => {
    const EVENT = {
      id: 'ev-1',
      title: 'Noche de sushi',
      description: 'Menú degustación',
      startsAt: new Date(Date.now() + 3 * 86400000).toISOString(),
      imageUrls: ['https://x/1.jpg', 'https://x/2.jpg', 'https://x/3.jpg', 'https://x/4.jpg'],
    };

    it('adjunta las fotos del evento, con tope de 3 como en v1', async () => {
      jest.spyOn(SupabaseService, 'getActiveEvents').mockResolvedValue([EVENT] as any);

      const result = await run('show_event_details', { eventId: 'ev-1' });

      expect(result.ok).toBe(true);
      expect(result.attachments).toHaveLength(3);
      expect(result.attachments?.[0].imageUrl).toBe('https://x/1.jpg');
      // El modelo tiene que avisar que la reserva de evento no queda confirmada sola.
      expect((result.data as any).requiresApproval).toBe(true);
    });

    it('pone el título como caption SÓLO en la primera foto', async () => {
      jest.spyOn(SupabaseService, 'getActiveEvents').mockResolvedValue([EVENT] as any);

      const result = await run('show_event_details', { eventId: 'ev-1' });

      expect(result.attachments?.[0].caption).toBe('🎉 *Noche de sushi*');
      expect(result.attachments?.[1].caption).toBeUndefined();
    });

    it('le dice al modelo cómo reservar el evento, en el propio resultado', async () => {
      jest.spyOn(SupabaseService, 'getActiveEvents').mockResolvedValue([EVENT] as any);

      const result = await run('show_event_details', { eventId: 'ev-1' });

      // La instrucción viaja con el resultado y no sólo en el system prompt: el
      // modelo la tiene delante justo cuando decide el próximo paso.
      expect((result.data as any).howToReserve).toContain('ev-1');
      expect((result.data as any).howToReserve).toContain('NO pases scheduledAt');
    });

    it('avisa cuando el comercio desactivó el evento entre el listado y la elección', async () => {
      jest.spyOn(SupabaseService, 'getActiveEvents').mockResolvedValue([]);

      const result = await run('show_event_details', { eventId: 'ev-1' });

      expect(result).toMatchObject({ ok: false, error: { code: 'event_not_available' } });
    });

    it('list_events no adjunta fotos — sólo señala cuáles tienen', async () => {
      jest.spyOn(SupabaseService, 'getActiveEvents').mockResolvedValue([EVENT] as any);

      const result = await run('list_events');

      // Listar cinco eventos no debe disparar quince imágenes.
      expect(result.attachments).toBeUndefined();
      expect((result.data as any).events[0].hasPhotos).toBe(true);
    });
  });

  describe('create_reservation con evento', () => {
    const EVENT_START = new Date(Date.now() + 4 * 86400000).toISOString();
    const EVENT = {
      id: 'ev-9',
      title: 'Noche de Jazz',
      description: null,
      startsAt: EVENT_START,
      imageUrls: [],
    };

    beforeEach(() => {
      jest.spyOn(SupabaseService, 'getActiveEvents').mockResolvedValue([EVENT] as any);
      jest.spyOn(SupabaseService, 'createReservation').mockResolvedValue({
        success: true,
        waitlistEntry: {
          id: 'r-9',
          display_code: 'JZ01',
          status: 'WAITING',
          scheduled_at: EVENT_START,
        },
      } as any);
    });

    it('toma la fecha del evento e IGNORA el scheduledAt que mandó el modelo', async () => {
      const createSpy = jest.spyOn(SupabaseService, 'createReservation');

      await run('create_reservation', {
        customerName: 'Ana',
        partySize: 2,
        eventId: 'ev-9',
        // El modelo resolvió una fecha por su cuenta: no debe prevalecer.
        scheduledAt: '2020-01-01T00:00:00.000Z',
      });

      expect(createSpy).toHaveBeenCalledWith(
        expect.objectContaining({ eventId: 'ev-9', scheduledAt: EVENT_START })
      );
    });

    it('rechaza en vez de crear una reserva común si el evento ya no existe', async () => {
      jest.spyOn(SupabaseService, 'getActiveEvents').mockResolvedValue([]);
      const createSpy = jest.spyOn(SupabaseService, 'createReservation');

      const result = await run('create_reservation', {
        customerName: 'Ana',
        partySize: 2,
        eventId: 'ev-borrado',
      });

      // Crear una reserva común en silencio sería peor que fallar: el cliente
      // pidió un evento.
      expect(result).toMatchObject({ ok: false, error: { code: 'event_not_available' } });
      expect(createSpy).not.toHaveBeenCalled();
    });

    it('confirma como "recibida" (pendiente de aprobación), no como confirmada', async () => {
      const result = await run('create_reservation', {
        customerName: 'Ana',
        partySize: 2,
        eventId: 'ev-9',
      });

      expect(result.ok).toBe(true);
      expect(result.verbatim).toContain('Noche de Jazz');
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
