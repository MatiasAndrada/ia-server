import { WhatsAppHandler } from '../../services/whatsapp-handler.service.js';
import { SupabaseService } from '../../services/supabase.service.js';
import * as orchestrator from '../../agent/orchestrator.js';
import * as state from '../../agent/state.js';
import { BaileysMessage } from '../../types/index.js';

jest.mock('../../utils/logger');

/**
 * Cubre lo que el orquestador NO puede cubrir por sí solo: lo que pasa antes y
 * después de él — el menú de idioma y el saludo de apertura del primer
 * contacto, y la entrega de imágenes.
 */

const BUSINESS_ID = '00000000-0000-0000-0000-000000000001';
const PHONE = '5491155551234';
const JID = `${PHONE}@s.whatsapp.net`;

describe('WhatsAppHandler — camino del agente', () => {
  let sent: string[];
  let images: { url: string; caption?: string }[];
  let handler: WhatsAppHandler;

  const stubBaileys = {
    sendMessage: jest.fn(async (_b: string, _to: string, text: string) => {
      sent.push(text);
      return true;
    }),
    sendImageMessage: jest.fn(async (_b: string, _to: string, url: string, caption?: string) => {
      images.push({ url, caption });
      return true;
    }),
    getSelfJid: jest.fn(() => ''),
  };

  function message(text: string): BaileysMessage {
    return {
      from: JID,
      message: text,
      timestamp: Date.now(),
      businessId: BUSINESS_ID,
      messageId: `m-${Math.random()}`,
      fromMe: false,
    };
  }

  function process(text: string): Promise<void> {
    return (
      handler as unknown as { _processMessage: (m: BaileysMessage) => Promise<void> }
    )._processMessage(message(text));
  }

  beforeEach(() => {
    jest.restoreAllMocks();
    sent = [];
    images = [];
    stubBaileys.sendMessage.mockClear();
    stubBaileys.sendImageMessage.mockClear();

    handler = new WhatsAppHandler(stubBaileys as any);

    jest.spyOn(SupabaseService, 'getBusinessById').mockResolvedValue({
      id: BUSINESS_ID,
      name: 'La Parrilla',
      whatsapp_session_id: 'session-active',
      language: 'es',
      weekly_hours: {},
    } as any);
    jest.spyOn(SupabaseService, 'getCustomerLanguage').mockResolvedValue('es');
    jest.spyOn(state, 'appendExchange').mockResolvedValue();
    jest.spyOn(state, 'setOnboardingStep').mockResolvedValue();
    jest.spyOn(state, 'clearOnboardingStep').mockResolvedValue();
    jest.spyOn(state, 'loadOnboardingStep').mockResolvedValue(null);
    jest.spyOn(SupabaseService, 'getActiveEvents').mockResolvedValue([]);
    // Sin historial por defecto = primer contacto. Los casos que necesitan una
    // conversación ya empezada lo sobrescriben.
    jest.spyOn(state, 'loadHistory').mockResolvedValue([]);
  });

  describe('menú de idioma en primer contacto', () => {
    it('lo muestra a un teléfono sin ficha y NO llega al orquestador', async () => {
      jest.spyOn(SupabaseService, 'getCustomerByPhone').mockResolvedValue(null);
      const turnSpy = jest.spyOn(orchestrator, 'handleTurn');

      await process('hola');

      expect(sent).toHaveLength(1);
      // El menú lista los tres idiomas soportados.
      expect(sent[0].toLowerCase()).toContain('español');
      expect(turnSpy).not.toHaveBeenCalled();
    });

    it('registra el menú en el historial para que el modelo entienda la respuesta siguiente', async () => {
      jest.spyOn(SupabaseService, 'getCustomerByPhone').mockResolvedValue(null);
      const appendSpy = jest.spyOn(state, 'appendExchange').mockResolvedValue();

      // Sin esto, el "2" del turno siguiente llegaría sin contexto.
      await process('hola');

      expect(appendSpy).toHaveBeenCalledWith(
        `${BUSINESS_ID}-${PHONE}`,
        'hola',
        expect.stringContaining('spañol')
      );
    });

    it('NO interrumpe una conversación ya empezada, aunque el cliente siga sin nombre', async () => {
      jest.spyOn(SupabaseService, 'getCustomerByPhone').mockResolvedValue(null);
      // Ya hay historial: el cliente viene conversando y está dando su nombre.
      jest.spyOn(state, 'loadHistory').mockResolvedValue([
        { role: 'user', content: 'hola, 4 personas para hoy' },
        { role: 'assistant', content: '¿A nombre de quién?' },
      ]);
      const turnSpy = jest.spyOn(orchestrator, 'handleTurn').mockResolvedValue({
        messages: ['Listo Matías.'],
        attachments: [],
        toolsCalled: [],
        iterations: 1,
      });

      await process('Matías Andrada');

      // El menú a mitad de flujo era el bug: "Matías Andrada" no es saludo y no
      // trae señal de idioma, así que caía en 'menu' y cortaba la conversación.
      expect(turnSpy).toHaveBeenCalled();
      expect(sent).toEqual(['Listo Matías.']);
    });

    it('NO se lo muestra a un cliente ya conocido del comercio', async () => {
      jest.spyOn(SupabaseService, 'getCustomerByPhone').mockResolvedValue({
        id: 'c1',
        name: 'Matías',
        lastName: null,
        preferred_language: 'es',
      } as any);

      await process('hola');

      // Ya eligió idioma alguna vez: lo que recibe es el saludo de apertura.
      expect(sent).toHaveLength(1);
      expect(sent[0].toLowerCase()).not.toContain('português');
    });
  });

  describe('alta de un cliente nuevo', () => {
    beforeEach(() => {
      jest.spyOn(SupabaseService, 'getCustomerByPhone').mockResolvedValue(null);
      jest.spyOn(SupabaseService, 'updateCustomerLanguage').mockResolvedValue(undefined as any);
      // Ya hay historial: el menú de idiomas se mandó en el turno anterior.
      jest.spyOn(state, 'loadHistory').mockResolvedValue([
        { role: 'user', content: 'hola' },
        { role: 'assistant', content: 'menú de idiomas' },
      ]);
    });

    it('tras elegir el idioma pregunta el nombre, sin pasar por el modelo', async () => {
      jest.spyOn(state, 'loadOnboardingStep').mockResolvedValue('language');
      const stepSpy = jest.spyOn(state, 'setOnboardingStep').mockResolvedValue();
      const turnSpy = jest.spyOn(orchestrator, 'handleTurn');

      await process('1');

      expect(sent).toHaveLength(1);
      expect(sent[0]).toContain('¿cómo te llamás?');
      expect(stepSpy).toHaveBeenCalledWith(`${BUSINESS_ID}-${PHONE}`, 'name');
      expect(turnSpy).not.toHaveBeenCalled();
    });

    it('con el nombre crea la ficha y manda el menú saludando por él', async () => {
      jest.spyOn(state, 'loadOnboardingStep').mockResolvedValue('name');
      const createSpy = jest
        .spyOn(SupabaseService, 'getOrCreateCustomer')
        .mockResolvedValue({ id: 'c1', name: 'Daniel' } as any);

      await process('Daniel');

      // Se persiste ahora y no al reservar: si se pierde, el próximo "hola"
      // vuelve a arrancar por el menú de idiomas.
      expect(createSpy).toHaveBeenCalledWith('Daniel', PHONE, BUSINESS_ID, null);
      expect(sent[0]).toContain('¡Hola, Daniel!');
      expect(sent[0]).toContain('Reservar una mesa');
    });

    it('acepta "me llamo Daniel Pérez" y separa el apellido', async () => {
      jest.spyOn(state, 'loadOnboardingStep').mockResolvedValue('name');
      const createSpy = jest
        .spyOn(SupabaseService, 'getOrCreateCustomer')
        .mockResolvedValue({ id: 'c1', name: 'Daniel' } as any);

      await process('me llamo daniel pérez');

      expect(createSpy).toHaveBeenCalledWith('Daniel', PHONE, BUSINESS_ID, 'Pérez');
    });

    it('si contesta otra cosa en vez del nombre, lo atiende el modelo sin insistir', async () => {
      jest.spyOn(state, 'loadOnboardingStep').mockResolvedValue('name');
      const clearSpy = jest.spyOn(state, 'clearOnboardingStep').mockResolvedValue();
      const createSpy = jest.spyOn(SupabaseService, 'getOrCreateCustomer');
      const turnSpy = jest.spyOn(orchestrator, 'handleTurn').mockResolvedValue({
        messages: ['Dale, ¿para cuántas personas?'],
        attachments: [],
        toolsCalled: [],
        iterations: 1,
      });

      await process('quiero reservar para hoy');

      // Nada de "no entendí, decime tu nombre": el alta se abandona y sigue la
      // conversación real.
      expect(clearSpy).toHaveBeenCalled();
      expect(createSpy).not.toHaveBeenCalled();
      expect(turnSpy).toHaveBeenCalled();
      expect(sent).toEqual(['Dale, ¿para cuántas personas?']);
    });

    it('si no elige idioma tampoco insiste: sigue el modelo', async () => {
      jest.spyOn(state, 'loadOnboardingStep').mockResolvedValue('language');
      const turnSpy = jest.spyOn(orchestrator, 'handleTurn').mockResolvedValue({
        messages: ['Contame qué necesitás.'],
        attachments: [],
        toolsCalled: [],
        iterations: 1,
      });

      await process('quiero una mesa para 4');

      expect(turnSpy).toHaveBeenCalled();
    });
  });

  describe('saludo de apertura', () => {
    const knownCustomer = {
      id: 'c1',
      name: 'Matías',
      lastName: null,
      preferred_language: 'es',
    };

    it('saluda por nombre y ofrece las dos opciones, sin llegar al orquestador', async () => {
      jest.spyOn(SupabaseService, 'getCustomerByPhone').mockResolvedValue(knownCustomer as any);
      const turnSpy = jest.spyOn(orchestrator, 'handleTurn');

      await process('hola');

      expect(sent).toHaveLength(1);
      expect(sent[0]).toContain('¡Hola, Matías!');
      expect(sent[0]).toContain('Reservar una mesa');
      expect(sent[0]).toContain('Modificar o cancelar una reserva');
      // Es texto fijo: el modelo no interviene en la carta de presentación.
      expect(turnSpy).not.toHaveBeenCalled();
    });

    it('lo registra en el historial para que el modelo entienda el "1" siguiente', async () => {
      jest.spyOn(SupabaseService, 'getCustomerByPhone').mockResolvedValue(knownCustomer as any);
      const appendSpy = jest.spyOn(state, 'appendExchange').mockResolvedValue();

      await process('hola');

      expect(appendSpy).toHaveBeenCalledWith(
        `${BUSINESS_ID}-${PHONE}`,
        'hola',
        expect.stringContaining('Reservar una mesa')
      );
    });

    it('lista los eventos vigentes y ofrece elegirlos por nombre', async () => {
      jest.spyOn(SupabaseService, 'getCustomerByPhone').mockResolvedValue(knownCustomer as any);
      jest.spyOn(SupabaseService, 'getActiveEvents').mockResolvedValue([
        {
          id: 'ev-1',
          title: 'Noche de Jazz',
          description: null,
          startsAt: new Date(Date.now() + 3 * 86400000).toISOString(),
          imageUrls: [],
        },
      ] as any);

      await process('hola');

      expect(sent[0]).toContain('Próximos eventos');
      expect(sent[0]).toContain('Noche de Jazz');
      expect(sent[0]).toContain('escribí el nombre del evento');
    });

    it('sin eventos no muestra la sección ni invita a nombrar uno', async () => {
      jest.spyOn(SupabaseService, 'getCustomerByPhone').mockResolvedValue(knownCustomer as any);
      jest.spyOn(SupabaseService, 'getActiveEvents').mockResolvedValue([]);

      await process('hola');

      // Ofrecer eventos que no existen deja al cliente escribiendo contra la nada.
      expect(sent[0]).not.toContain('Próximos eventos');
      expect(sent[0]).not.toContain('nombre del evento');
      expect(sent[0]).toContain('Reservar una mesa');
    });

    it('NO lo muestra si el primer mensaje ya trae el pedido', async () => {
      jest.spyOn(SupabaseService, 'getCustomerByPhone').mockResolvedValue(knownCustomer as any);
      const turnSpy = jest.spyOn(orchestrator, 'handleTurn').mockResolvedValue({
        messages: ['Listo Matías, mesa para 4.'],
        attachments: [],
        toolsCalled: ['create_reservation'],
        iterations: 2,
      });

      await process('hoy 21:30 para 4');

      // Mostrarle un menú sería hacerle repetir lo que acaba de escribir.
      expect(turnSpy).toHaveBeenCalled();
      expect(sent).toEqual(['Listo Matías, mesa para 4.']);
    });

    it('NO lo repite a mitad de conversación', async () => {
      jest.spyOn(SupabaseService, 'getCustomerByPhone').mockResolvedValue(knownCustomer as any);
      jest.spyOn(state, 'loadHistory').mockResolvedValue([
        { role: 'assistant', content: '¿Para cuántas personas?' },
      ]);
      const turnSpy = jest.spyOn(orchestrator, 'handleTurn').mockResolvedValue({
        messages: ['Perfecto.'],
        attachments: [],
        toolsCalled: [],
        iterations: 1,
      });

      // Un "hola" suelto en medio del flujo no reinicia nada.
      await process('hola');

      expect(turnSpy).toHaveBeenCalled();
      expect(sent).toEqual(['Perfecto.']);
    });
  });

  describe('entrega de adjuntos', () => {
    it('envía las imágenes ANTES del texto', async () => {
      const order: string[] = [];
      stubBaileys.sendMessage.mockImplementation(async (_b: string, _to: string, text: string) => {
        order.push(`texto:${text}`);
        sent.push(text);
        return true;
      });
      stubBaileys.sendImageMessage.mockImplementation(
        async (_b: string, _to: string, url: string, caption?: string) => {
          order.push(`imagen:${url}`);
          images.push({ url, caption });
          return true;
        }
      );

      jest.spyOn(SupabaseService, 'getCustomerByPhone').mockResolvedValue({
        id: 'c1',
        name: 'Matías',
        preferred_language: 'es',
      } as any);
      jest.spyOn(orchestrator, 'handleTurn').mockResolvedValue({
        messages: ['La noche de sushi es el sábado.'],
        attachments: [{ imageUrl: 'https://x/1.jpg', caption: '🎉 *Noche de sushi*' }],
        toolsCalled: ['show_event_details'],
        iterations: 2,
      });

      await process('contame del evento de sushi');

      // Las fotos enganchan y el detalle queda como último mensaje visible.
      expect(order).toEqual(['imagen:https://x/1.jpg', 'texto:La noche de sushi es el sábado.']);
      expect(images[0].caption).toBe('🎉 *Noche de sushi*');
    });

    it('envía todas las imágenes en orden', async () => {
      jest.spyOn(SupabaseService, 'getCustomerByPhone').mockResolvedValue({
        id: 'c1',
        name: 'Matías',
        preferred_language: 'es',
      } as any);
      jest.spyOn(orchestrator, 'handleTurn').mockResolvedValue({
        messages: ['La noche de sushi es el sábado.'],
        attachments: [{ imageUrl: 'https://x/1.jpg' }, { imageUrl: 'https://x/2.jpg' }],
        toolsCalled: ['show_event_details'],
        iterations: 2,
      });

      await process('contame del evento de sushi');

      expect(sent).toEqual(['La noche de sushi es el sábado.']);
      expect(images.map((i) => i.url)).toEqual(['https://x/1.jpg', 'https://x/2.jpg']);
    });
  });
});
