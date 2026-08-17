/**
 * End-to-end de los flujos de idioma contra el WhatsAppHandler real, con los
 * servicios externos mockeados — misma técnica que whatsapp-handler.service.test.ts.
 *
 * Cubre lo que los unit tests de detect.ts no pueden: que el menú se ofrezca en
 * el primer contacto, que NO bloquee el flujo, que el cambio mid-flow conserve
 * el draft, y que un cliente recurrente no vuelva a ver el menú.
 */

import { WhatsAppHandler } from '../../services/whatsapp-handler.service';
import { SupabaseService } from '../../services/supabase.service';
import { ReservationService } from '../../services/reservation.service';
import { agentService } from '../../services/agent.service';
import * as languageStore from '../../i18n/language-store';
import { ReservationDraft } from '../../types';

jest.mock('../../utils/logger');

const BUSINESS_ID = 'business-1';
const PHONE = '5491231231231';
const JID = `${PHONE}@s.whatsapp.net`;
const CONVERSATION_ID = `${BUSINESS_ID}-${PHONE}`;

describe('flujos de idioma', () => {
  let handler: WhatsAppHandler;
  let sendMessage: jest.Mock<Promise<boolean>, [string, string, string]>;
  let persistLanguageSpy: jest.SpyInstance;

  /** Todos los textos que el bot envió, en orden. */
  const sent = (): string[] => sendMessage.mock.calls.map((call) => call[2]);

  function mockCustomer(overrides: Record<string, unknown> = {}) {
    jest.spyOn(SupabaseService, 'getCustomerByPhone').mockResolvedValue({
      id: 'customer-1',
      phone: PHONE,
      business_id: BUSINESS_ID,
      name: null,
      lastName: null,
      preferred_language: null,
      ...overrides,
    } as any);
  }

  function mockDraft(draft: Partial<ReservationDraft> | null) {
    jest
      .spyOn(ReservationService, 'getDraft')
      .mockResolvedValue(
        draft
          ? ({
              conversationId: CONVERSATION_ID,
              businessId: BUSINESS_ID,
              createdAt: Date.now(),
              updatedAt: Date.now(),
              ...draft,
            } as ReservationDraft)
          : null
      );
  }

  async function deliver(message: string) {
    await (handler as any)._processMessage({
      from: JID,
      businessId: BUSINESS_ID,
      message,
      fromMe: false,
    });
  }

  beforeEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();

    sendMessage = jest.fn<Promise<boolean>, [string, string, string]>().mockResolvedValue(true);
    handler = new WhatsAppHandler({
      sendMessage,
      getSelfJid: jest.fn().mockReturnValue(''),
    } as any);

    jest.spyOn(SupabaseService, 'getBusinessById').mockResolvedValue({
      id: BUSINESS_ID,
      name: 'La Parrilla',
      city: 'Puerto Iguazú',
      language: 'es',
      whatsapp_session_id: 'session-active',
    } as any);
    jest.spyOn(SupabaseService, 'getBlockedDates').mockResolvedValue(new Map());
    jest.spyOn(SupabaseService, 'getActiveReservationsByPhone').mockResolvedValue([]);
    jest.spyOn(SupabaseService, 'getActiveReservationByPhone').mockResolvedValue(null);
    jest.spyOn(SupabaseService, 'getCustomerLanguage').mockResolvedValue(null);
    jest.spyOn(SupabaseService, 'updateCustomerLanguage').mockResolvedValue(true);

    // La cache de Redis no está disponible en tests: se simula vacía.
    jest.spyOn(languageStore, 'getCachedLanguage').mockResolvedValue(null);
    jest.spyOn(languageStore, 'cacheDetectedLanguage').mockResolvedValue(undefined);
    persistLanguageSpy = jest
      .spyOn(languageStore, 'persistLanguage')
      .mockResolvedValue(undefined);

    jest.spyOn(ReservationService, 'saveDraft').mockResolvedValue(true);
    // Safety net: any scenario that falls through to the free-text agent
    // fallback (e.g. a message that doesn't cleanly prefill a reservation)
    // must not hit the real OpenRouter API from a unit test.
    jest.spyOn(agentService, 'generateResponse').mockResolvedValue({
      response: '',
      action: null,
      agent: { id: 'waitlist', name: 'Asistente de Reservas' },
    });
    mockCustomer();
    mockDraft(null);
  });

  describe('menú de bienvenida en el primer contacto', () => {
    it('ofrece el menú en vez de preguntar el nombre', async () => {
      jest.spyOn(ReservationService, 'startReservation').mockResolvedValue({} as any);

      await deliver('Hola');

      const [first] = sent();
      expect(first).toContain('La Parrilla');
      expect(first).toContain('Puerto Iguazú');
      expect(first).toContain('1️⃣ 🇪🇸 Español');
      expect(first).toContain('2️⃣ 🇬🇧 English');
      expect(first).toContain('3️⃣ 🇧🇷 Português');
    });

    it('marca el draft con awaitingLanguageChoice sin crear un step nuevo', async () => {
      const startReservation = jest
        .spyOn(ReservationService, 'startReservation')
        .mockResolvedValue({} as any);

      await deliver('Hola');

      // El tercer argumento es awaitingLanguageChoice: el step sigue siendo 'name'.
      expect(startReservation).toHaveBeenCalledWith(CONVERSATION_ID, BUSINESS_ID, true);
    });

    it('saltea el menú cuando el primer mensaje combina saludo + intención con idioma inferible, y avisa que se puede cambiar', async () => {
      // Encontrado originalmente con scripts/chat-simulator.ts: "oi, mesa pra 4"
      // no matchea isGreetingMessage (no es SOLO un saludo) y caía directo en
      // handlePrefilledReservationRequest, que intentaba parsear "oi" como
      // parte del nombre. Ese riesgo ahora está cerrado en la raíz —
      // couldBeAName rechaza cualquier candidato con un dígito, en cualquier
      // idioma — así que un mensaje con contenido real y detección de idioma
      // confiable ya no necesita interrumpir con el menú: se manda un
      // recordatorio corto de que el idioma se puede cambiar y se sigue
      // procesando el resto del mensaje en el idioma inferido.
      jest.spyOn(ReservationService, 'startReservation').mockResolvedValue({} as any);

      await deliver('oi, mesa pra 4');

      const [first] = sent();
      expect(first).not.toContain('Bem-vindo');
      expect(first).not.toContain('1️⃣ 🇪🇸 Español');
      expect(first).toContain('Para trocar de idioma');
      expect(persistLanguageSpy).not.toHaveBeenCalled();
      expect(languageStore.cacheDetectedLanguage).toHaveBeenCalledWith(
        BUSINESS_ID,
        PHONE,
        'pt'
      );
    });

    it('sigue mostrando el menú completo ante un saludo puro, aunque el idioma se pueda inferir', async () => {
      // Caso del ejemplo original: "hola" solo no tiene nada más para procesar,
      // así que sigue valiendo la pena preguntar en vez de asumir.
      jest.spyOn(ReservationService, 'startReservation').mockResolvedValue({} as any);

      await deliver('hola');

      const [first] = sent();
      expect(first).toContain('1️⃣ 🇪🇸 Español');
    });

    it('muestra el menú cuando el idioma no se puede inferir con confianza, aunque haya contenido', async () => {
      // "mesa para 4" no tiene ningún marcador fuerte de idioma (ver
      // MARKERS en i18n/detect.ts) — detectLanguage devuelve null y, ante la
      // duda, se sigue prefiriendo preguntar en vez de asumir.
      jest.spyOn(ReservationService, 'startReservation').mockResolvedValue({} as any);

      await deliver('mesa para 4');

      const [first] = sent();
      expect(first).toContain('1️⃣ 🇪🇸 Español');
    });

    it('emite el menú en el idioma detectado del primer mensaje', async () => {
      jest.spyOn(ReservationService, 'startReservation').mockResolvedValue({} as any);

      await deliver('hello');

      expect(sent()[0]).toContain('Welcome to');
      // Auto-detección: se cachea pero NO se persiste como elección del cliente,
      // para que el menú se le siga ofreciendo.
      expect(languageStore.cacheDetectedLanguage).toHaveBeenCalledWith(
        BUSINESS_ID,
        PHONE,
        'en'
      );
      expect(persistLanguageSpy).not.toHaveBeenCalled();
    });

    it('no vuelve a ofrecer el menú a un cliente que ya eligió', async () => {
      mockCustomer({ preferred_language: 'pt' });
      jest.spyOn(SupabaseService, 'getCustomerLanguage').mockResolvedValue('pt');
      jest.spyOn(ReservationService, 'startReservation').mockResolvedValue({} as any);

      await deliver('Oi');

      expect(sent()[0]).not.toContain('1️⃣ 🇪🇸 Español');
    });

    it('a un cliente recurrente lo saluda en su idioma y le ofrece cómo cambiarlo', async () => {
      mockCustomer({ name: 'João', preferred_language: 'pt' });
      jest.spyOn(SupabaseService, 'getCustomerLanguage').mockResolvedValue('pt');
      jest
        .spyOn(ReservationService, 'startReservationForKnownCustomer')
        .mockResolvedValue({} as any);

      await deliver('Oi');

      const [first] = sent();
      expect(first).toContain('Olá João');
      expect(first).toContain('Para trocar de idioma');
    });
  });

  describe('selección desde el menú', () => {
    beforeEach(() => {
      mockDraft({ step: 'name', awaitingLanguageChoice: true });
    });

    it('el número elige el idioma y pregunta el nombre en ese idioma', async () => {
      await deliver('2');

      expect(persistLanguageSpy).toHaveBeenCalledWith(BUSINESS_ID, PHONE, 'en');
      expect(sent()[0]).toBe("What's your first and last name for the booking?");
    });

    it('una bandera también elige el idioma', async () => {
      await deliver('🇧🇷');

      expect(persistLanguageSpy).toHaveBeenCalledWith(BUSINESS_ID, PHONE, 'pt');
      expect(sent()[0]).toContain('nome e sobrenome');
    });

    it('NO bloquea: si el cliente responde su nombre, el flujo avanza igual', async () => {
      const setCustomerName = jest
        .spyOn(ReservationService, 'setCustomerNameParts')
        .mockResolvedValue({ step: 'party_size', customerName: 'Matías' } as any);

      await deliver('Matías Andrada');

      // No se eligió idioma...
      expect(persistLanguageSpy).not.toHaveBeenCalled();
      // ...pero el nombre sí se tomó y el flujo siguió.
      expect(setCustomerName).toHaveBeenCalled();
      expect(sent().join('\n')).not.toContain('1️⃣ 🇪🇸 Español');
    });
  });

  describe('cambio de idioma mid-flow', () => {
    it('conserva el draft y re-emite la pregunta pendiente en el idioma nuevo', async () => {
      // El caso del plan: el cliente está en el step `time` con fecha y
      // cantidad ya elegidas, y pide cambiar de idioma.
      const draft = {
        step: 'time' as const,
        partySize: 4,
        scheduledDate: '2026-07-24',
        customerName: 'Matías',
      };
      mockDraft(draft);
      const deleteDraft = jest.spyOn(ReservationService, 'deleteDraft').mockResolvedValue(true);

      await deliver('quiero cambiar el idioma a inglés');

      expect(persistLanguageSpy).toHaveBeenCalledWith(BUSINESS_ID, PHONE, 'en');
      // El draft NO se toca: no se pierden personas ni fecha.
      expect(deleteDraft).not.toHaveBeenCalled();

      const messages = sent();
      expect(messages[0]).toBe("✅ Done! We'll continue in English.");
      // Y se re-emite la pregunta de hora, ahora en inglés.
      expect(messages[1]).toContain('What time would you like to book');
    });

    it('una bandera mid-flow también cambia el idioma', async () => {
      mockDraft({ step: 'party_size', customerName: 'Matías' });

      await deliver('🇧🇷');

      expect(persistLanguageSpy).toHaveBeenCalledWith(BUSINESS_ID, PHONE, 'pt');
      const messages = sent();
      expect(messages[0]).toContain('Vamos continuar em português');
      expect(messages[1]).toContain('Para quantas pessoas');
    });

    it('mencionar un idioma al pasar NO cambia el idioma', async () => {
      // Riesgo #2 del plan: ES y PT son cercanos y la gente menciona
      // nacionalidades mientras reserva.
      mockDraft({ step: 'party_size', customerName: 'Matías' });
      jest.spyOn(ReservationService, 'setPartySize').mockResolvedValue({} as any);

      await deliver('somos 6, vinieron unos amigos brasileños');

      expect(persistLanguageSpy).not.toHaveBeenCalled();
      expect(sent().join('\n')).not.toContain('Vamos continuar em português');
    });

    it('sin draft activo solo confirma el cambio, sin inventar una pregunta', async () => {
      mockDraft(null);

      await deliver('english please');

      expect(persistLanguageSpy).toHaveBeenCalledWith(BUSINESS_ID, PHONE, 'en');
      expect(sent()).toEqual(["✅ Done! We'll continue in English."]);
    });
  });

  describe('mensaje de servicio inactivo', () => {
    it('sale en el idioma del cliente', async () => {
      jest.spyOn(SupabaseService, 'getBusinessById').mockResolvedValue({
        id: BUSINESS_ID,
        name: 'La Parrilla',
        language: 'es',
        whatsapp_session_id: null,
      } as any);
      jest.spyOn(SupabaseService, 'getCustomerLanguage').mockResolvedValue('en');
      mockCustomer({ preferred_language: 'en' });
      // El throttle vive en Redis, no disponible en tests.
      jest.spyOn(handler as any, 'shouldSendInactiveFallback').mockResolvedValue(true);

      await deliver('hello');

      expect(sent()[0]).toContain('our WhatsApp service is unavailable');
    });
  });
});
