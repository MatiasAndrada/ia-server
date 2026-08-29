import { WhatsAppHandler } from '../../services/whatsapp-handler.service.js';
import { SupabaseService } from '../../services/supabase.service.js';
import { __setAgentModeForTests } from '../../agent/feature-flag.js';
import * as orchestrator from '../../agent/orchestrator.js';
import * as state from '../../agent/state.js';
import { BaileysMessage } from '../../types/index.js';

jest.mock('../../utils/logger');

/**
 * Camino v2 dentro del handler.
 *
 * Cubre lo que el orquestador NO puede cubrir por sí solo: lo que pasa antes y
 * después de él — el menú de idioma del primer contacto (que v1 hacía en
 * `_processMessageLocalized`, del que v2 se desvía) y la entrega de imágenes.
 */

const BUSINESS_ID = '00000000-0000-0000-0000-000000000001';
const PHONE = '5491155551234';
const JID = `${PHONE}@s.whatsapp.net`;

describe('handler — camino agente v2', () => {
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

    __setAgentModeForTests('v2', [BUSINESS_ID]);
    handler = new WhatsAppHandler(stubBaileys as any);

    jest.spyOn(SupabaseService, 'getBusinessById').mockResolvedValue({
      id: BUSINESS_ID,
      name: 'La Parrilla',
      whatsapp_session_id: 'session-active',
      language: 'es',
      weekly_hours: {},
    } as any);
    jest.spyOn(SupabaseService, 'getCustomerLanguage').mockResolvedValue('es');
    jest.spyOn(state, 'appendAssistantMessage').mockResolvedValue();
  });

  afterEach(() => __setAgentModeForTests('v1'));

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
      const appendSpy = jest.spyOn(state, 'appendAssistantMessage').mockResolvedValue();

      await process('hola');

      // Sin esto, el "2" del turno siguiente llegaría sin contexto.
      expect(appendSpy).toHaveBeenCalledWith(`${BUSINESS_ID}-${PHONE}`, expect.stringContaining('spañol'));
    });

    it('NO interrumpe a un cliente ya conocido del comercio', async () => {
      jest.spyOn(SupabaseService, 'getCustomerByPhone').mockResolvedValue({
        id: 'c1',
        name: 'Matías',
        lastName: null,
        preferred_language: 'es',
      } as any);
      const turnSpy = jest.spyOn(orchestrator, 'handleTurn').mockResolvedValue({
        messages: ['¡Hola Matías!'],
        attachments: [],
        toolsCalled: [],
        iterations: 1,
      });

      await process('hola');

      expect(turnSpy).toHaveBeenCalled();
      expect(sent).toEqual(['¡Hola Matías!']);
    });
  });

  describe('entrega de adjuntos', () => {
    it('envía las imágenes ANTES del texto, como hacía applyEventChoice en v1', async () => {
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

  describe('modo v1', () => {
    it('no toca el orquestador cuando el comercio no está en la lista', async () => {
      __setAgentModeForTests('v1');
      jest.spyOn(SupabaseService, 'getCustomerByPhone').mockResolvedValue(null);
      const turnSpy = jest.spyOn(orchestrator, 'handleTurn');

      await process('hola');

      expect(turnSpy).not.toHaveBeenCalled();
    });
  });
});
