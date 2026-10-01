import { RedisConfig } from '../../config/redis.js';
import {
  AUTO_REPLY_WINDOW_MS,
  isPhoneAutoReply,
  noteCustomerMessage,
  resetPhoneAutoRepliesForTests,
} from '../../adaptations/phone-auto-replies.js';

jest.mock('../../utils/logger');

/**
 * El celular de De La Fonte tiene configurado el saludo de WhatsApp Business,
 * y al servidor le llega igual que un mensaje que tipeó Simona. Si se lo
 * tomara como "la persona está atendiendo", el bot se callaría con cada
 * cliente nuevo. Los tiempos de estos tests salen de los logs de producción
 * del 29 y 30/09: el saludo llegó a 1–2 s del cliente; la respuesta humana
 * más rápida, a 12 s.
 */

const BUSINESS_ID = 'aaf0bb70-0000-0000-0000-000000000000';
const OTHER_BUSINESS_ID = 'd4597a2e-0000-0000-0000-000000000000';
const PHONE = '5493757323741';

/** El saludo real del celular de De La Fonte (tal cual llegó a los logs). */
const PHONE_GREETING =
  'Hola! 👏🏻 Bienvenido/a\nEste número es compartido \nEn que te puedo ayudar?\n' +
  '👩‍🦱Hablar con Simona > escribi Simona\n🍷Reservas "De La Fonte \n' +
  '👉storied-mooncake-696950.netlify.app';

const T0 = 1_790_000_000_000;

describe('¿lo escribió la persona o lo mandó el celular solo?', () => {
  let sets: Map<string, Set<string>>;

  beforeEach(() => {
    jest.restoreAllMocks();
    resetPhoneAutoRepliesForTests();
    sets = new Map();

    jest.spyOn(RedisConfig, 'isReady').mockReturnValue(true);
    jest.spyOn(RedisConfig, 'getClient').mockReturnValue({
      sAdd: jest.fn(async (key: string, member: string) => {
        const set = sets.get(key) ?? new Set<string>();
        const added = set.has(member) ? 0 : 1;
        set.add(member);
        sets.set(key, set);
        return added;
      }),
      sIsMember: jest.fn(async (key: string, member: string) => (sets.get(key)?.has(member) ? 1 : 0)),
      expire: jest.fn(async () => 1),
    } as any);
  });

  describe('por el tiempo', () => {
    it.each([1_000, 2_000, AUTO_REPLY_WINDOW_MS])(
      'a %i ms del mensaje del cliente es el celular solo',
      async (delay) => {
        noteCustomerMessage(BUSINESS_ID, PHONE, T0);

        expect(await isPhoneAutoReply(BUSINESS_ID, PHONE, PHONE_GREETING, T0 + delay)).toBe(true);
      }
    );

    it.each([12_000, 52_000, 42_308_000])(
      'a %i ms es una respuesta de la persona',
      async (delay) => {
        noteCustomerMessage(BUSINESS_ID, PHONE, T0);

        expect(await isPhoneAutoReply(BUSINESS_ID, PHONE, 'Hola Tobi! Recién veo tu mensaje', T0 + delay)).toBe(
          false
        );
      }
    );

    it('sin mensaje previo del cliente, lo escribió ella (le escribe primero a un amigo)', async () => {
      expect(await isPhoneAutoReply(BUSINESS_ID, PHONE, 'Buen diaaa! ¿Fue Gasto a ver el aire?', T0)).toBe(
        false
      );
    });

    it('cuenta sólo el mensaje del cliente de ESE chat', async () => {
      noteCustomerMessage(BUSINESS_ID, '5491100000000', T0);

      expect(await isPhoneAutoReply(BUSINESS_ID, PHONE, 'Hola!', T0 + 1_000)).toBe(false);
    });

    it('un audio del cliente también dispara el saludo, y también cuenta', async () => {
      // `noteCustomerMessage` no mira el contenido: lo llama Baileys para
      // cualquier mensaje del cliente, texto o no.
      noteCustomerMessage(BUSINESS_ID, PHONE, T0);

      expect(await isPhoneAutoReply(BUSINESS_ID, PHONE, PHONE_GREETING, T0 + 1_500)).toBe(true);
    });
  });

  describe('por el texto', () => {
    it('el saludo que ya se vio llegar solo se reconoce aunque llegue tarde', async () => {
      noteCustomerMessage(BUSINESS_ID, PHONE, T0);
      await isPhoneAutoReply(BUSINESS_ID, PHONE, PHONE_GREETING, T0 + 1_000);

      // Otro cliente, y el celular estaba sin conexión: el saludo sale 10 min después.
      const otroCliente = '5493757000000';
      noteCustomerMessage(BUSINESS_ID, otroCliente, T0 + 60_000);
      expect(
        await isPhoneAutoReply(BUSINESS_ID, otroCliente, PHONE_GREETING, T0 + 60_000 + 600_000)
      ).toBe(true);
    });

    it('no le importan los espacios ni los saltos de línea', async () => {
      noteCustomerMessage(BUSINESS_ID, PHONE, T0);
      await isPhoneAutoReply(BUSINESS_ID, PHONE, PHONE_GREETING, T0 + 1_000);

      const reformateado = PHONE_GREETING.replace(/\n/g, '  \n ');
      expect(await isPhoneAutoReply(BUSINESS_ID, PHONE, reformateado, T0 + 900_000)).toBe(true);
    });

    it('un "Hola!" que ella tipeó rápido no vuelve automático a cada "Hola!" suyo', async () => {
      noteCustomerMessage(BUSINESS_ID, PHONE, T0);
      expect(await isPhoneAutoReply(BUSINESS_ID, PHONE, 'Hola!', T0 + 3_000)).toBe(true);

      expect(await isPhoneAutoReply(BUSINESS_ID, PHONE, 'Hola!', T0 + 3_600_000)).toBe(false);
    });

    it('lo aprendido en un comercio no vale para otro', async () => {
      noteCustomerMessage(BUSINESS_ID, PHONE, T0);
      await isPhoneAutoReply(BUSINESS_ID, PHONE, PHONE_GREETING, T0 + 1_000);

      expect(await isPhoneAutoReply(OTHER_BUSINESS_ID, PHONE, PHONE_GREETING, T0 + 900_000)).toBe(
        false
      );
    });

    it('un mensaje largo que ella escribe a mano no se confunde con el saludo', async () => {
      noteCustomerMessage(BUSINESS_ID, PHONE, T0);
      await isPhoneAutoReply(BUSINESS_ID, PHONE, PHONE_GREETING, T0 + 1_000);

      expect(
        await isPhoneAutoReply(
          BUSINESS_ID,
          PHONE,
          'Como el es español podría pedirles cuánto exactamente pagó en euro? Así les hago la transferencia',
          T0 + 900_000
        )
      ).toBe(false);
    });
  });

  describe('degradación', () => {
    it('con Redis caído decide sólo por el tiempo', async () => {
      jest.spyOn(RedisConfig, 'isReady').mockReturnValue(false);
      noteCustomerMessage(BUSINESS_ID, PHONE, T0);

      expect(await isPhoneAutoReply(BUSINESS_ID, PHONE, PHONE_GREETING, T0 + 1_000)).toBe(true);
      expect(await isPhoneAutoReply(BUSINESS_ID, PHONE, PHONE_GREETING, T0 + 900_000)).toBe(false);
    });

    it('si Redis falla a mitad de camino, no lanza', async () => {
      jest.spyOn(RedisConfig, 'getClient').mockReturnValue({
        sAdd: jest.fn(async () => {
          throw new Error('boom');
        }),
        sIsMember: jest.fn(async () => {
          throw new Error('boom');
        }),
        expire: jest.fn(),
      } as any);
      noteCustomerMessage(BUSINESS_ID, PHONE, T0);

      await expect(isPhoneAutoReply(BUSINESS_ID, PHONE, PHONE_GREETING, T0 + 1_000)).resolves.toBe(
        true
      );
      await expect(isPhoneAutoReply(BUSINESS_ID, PHONE, PHONE_GREETING, T0 + 900_000)).resolves.toBe(
        false
      );
    });
  });
});
