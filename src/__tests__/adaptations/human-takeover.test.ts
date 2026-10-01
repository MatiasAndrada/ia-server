import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RedisConfig } from '../../config/redis.js';
import { antigalAdaptation } from '../../adaptations/antigal.js';
import { deLaFonteAdaptation } from '../../adaptations/de-la-fonte.js';
import { laMisionAdaptation } from '../../adaptations/la-mision.js';
import { skyAdaptation } from '../../adaptations/sky.js';
import {
  handOffWithoutReply,
  interceptSharedNumberTurn,
  isBotMuted,
  registerHumanReply,
  type SharedNumberAdaptation,
} from '../../adaptations/index.js';
import { resetHandoffStoreForTests } from '../../adaptations/handoff-store.js';

jest.mock('../../utils/logger');

/**
 * Lo que pidieron los locales de número compartido: "si Simona o Valentina le
 * mandan un mensaje a un amigo y el amigo le contesta, que no le conteste el
 * bot". Acá se prueba el motor (qué queda en silencio, cuánto, y qué lo
 * levanta); el reconocimiento de "lo escribió ella" está en
 * phone-auto-replies.test.ts y el cableado con WhatsApp en
 * whatsapp-handler.human-takeover.test.ts.
 */

const BUSINESS_ID = '00000000-0000-0000-0000-000000000042';
const CHAT = `${BUSINESS_ID}-5491155550001`;
const OTHER_CHAT = `${BUSINESS_ID}-5491155550002`;

const intercept = (adaptation: SharedNumberAdaptation, text: string, chat = CHAT) =>
  interceptSharedNumberTurn(adaptation, chat, text);

describe('la persona del local escribió en el chat', () => {
  let store: Map<string, string>;
  let ttls: Map<string, number>;
  let handoffFile: string;

  beforeEach(async () => {
    jest.restoreAllMocks();
    store = new Map();
    ttls = new Map();
    resetHandoffStoreForTests();
    handoffFile = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'handoffs-')), 'h.jsonl');
    process.env.SHARED_NUMBER_HANDOFF_FILE = handoffFile;

    jest.spyOn(RedisConfig, 'isReady').mockReturnValue(true);
    jest.spyOn(RedisConfig, 'getClient').mockReturnValue({
      get: jest.fn(async (key: string) => store.get(key) ?? null),
      setEx: jest.fn(async (key: string, ttl: number, value: string) => {
        store.set(key, value);
        ttls.set(key, ttl);
        return 'OK';
      }),
      del: jest.fn(async (key: string) => (store.delete(key) ? 1 : 0)),
    } as any);
  });

  afterEach(() => {
    delete process.env.SHARED_NUMBER_HANDOFF_FILE;
  });

  /**
   * SKY, La Misión y Antigal: el chat queda en manos de la persona por
   * cuarenta y ocho horas desde su último mensaje, y sólo la palabra de reserva SOLA
   * se lo devuelve al bot.
   */
  describe.each([
    { adaptation: antigalAdaptation, resume: ['Reservar', 'reserva', 'Cancelar', 'RESERVAS'] },
    { adaptation: skyAdaptation, resume: ['Reserva', 'reservar', 'cancelar'] },
    {
      adaptation: laMisionAdaptation,
      resume: ['LA MISIÓN', 'la mision', 'Misión', 'Reservar', 'Cancelar'],
    },
  ])('$adaptation.id', ({ adaptation, resume }) => {
    it('lo que responde el otro después ya no lo contesta el bot', async () => {
      await registerHumanReply(adaptation, CHAT);

      for (const text of ['jajaja sí', 'hola!', 'mañana paso a las 10', 'gracias!!', '👍🏻']) {
        expect(await intercept(adaptation, text)).toEqual({ action: 'silence', reason: 'human' });
      }
    });

    it('una palabra de reserva en medio de la charla es para ella, no para el bot', async () => {
      await registerHumanReply(adaptation, CHAT);

      for (const text of [
        '¿tenés mesa para el sábado?',
        'quiero reservar para 4 el viernes',
        'che, cancelá lo de mañana',
        'mesa',
        'turno',
      ]) {
        expect((await intercept(adaptation, text)).action).toBe('silence');
      }
    });

    it('nombrarla o pedir por ella tampoco hace aparecer al bot', async () => {
      await registerHumanReply(adaptation, CHAT);

      for (const text of ['Valentina', 'SKY', 'consultas', 'PERSONAL', '1']) {
        expect((await intercept(adaptation, text)).action).toBe('silence');
      }
    });

    it.each(resume)('"%s" solo le devuelve el chat al bot, y el bot lo atiende', async (text) => {
      await registerHumanReply(adaptation, CHAT);

      expect(await intercept(adaptation, text)).toEqual({ action: 'continue' });
      // Y ya no queda silencio: lo siguiente también lo atiende el bot.
      expect(await intercept(adaptation, 'para 4 personas')).toEqual({ action: 'continue' });
      expect(await isBotMuted(adaptation, CHAT)).toBe(false);
    });

    it('dura cuarenta y ocho horas y se renueva con cada mensaje suyo', async () => {
      expect(await registerHumanReply(adaptation, CHAT)).toBe(true);
      expect(await registerHumanReply(adaptation, CHAT)).toBe(false);

      const key = `adaptation:${adaptation.id}:human:${CHAT}`;
      expect(ttls.get(key)).toBe(48 * 60 * 60);
      expect(RedisConfig.getClient().setEx).toHaveBeenCalledTimes(2);
    });

    it('cuando vence, el bot vuelve a atender', async () => {
      await registerHumanReply(adaptation, CHAT);
      store.delete(`adaptation:${adaptation.id}:human:${CHAT}`); // lo que hace el TTL

      expect(await intercept(adaptation, 'hola')).toEqual({ action: 'continue' });
    });

    it('el silencio es de ese chat, no del comercio', async () => {
      await registerHumanReply(adaptation, CHAT);

      expect(await intercept(adaptation, 'hola', OTHER_CHAT)).toEqual({ action: 'continue' });
    });

    it('también levanta un traspaso previo: el cliente pidió volver al bot', async () => {
      // El cliente pidió por la persona, ella le contestó, y ahora quiere reservar.
      await handOffWithoutReply(adaptation, CHAT);
      await registerHumanReply(adaptation, CHAT);

      expect((await intercept(adaptation, resume[0]!)).action).toBe('continue');
      expect(await isBotMuted(adaptation, CHAT)).toBe(false);
    });

    it('con Redis caído no se puede registrar: el bot sigue atendiendo', async () => {
      jest.spyOn(RedisConfig, 'isReady').mockReturnValue(false);

      expect(await registerHumanReply(adaptation, CHAT)).toBe(false);
      expect(await intercept(adaptation, 'hola')).toEqual({ action: 'continue' });
    });
  });

  /**
   * De La Fonte ya había pedido que el bot no vuelva nunca a un chat que
   * atiende una persona. Que escriba Simona es exactamente eso.
   */
  describe('delafonte (permanente)', () => {
    const adaptation = deLaFonteAdaptation;

    it('queda en silencio para siempre: nada lo reactiva', async () => {
      await registerHumanReply(adaptation, CHAT);

      for (const text of ['Reservar', 'RESERVAR', 'Cancelar', 'quiero reservar una mesa', 'hola']) {
        expect((await intercept(adaptation, text)).action).toBe('silence');
      }
    });

    it('queda en el archivo local, no en Redis, y sobrevive a un reinicio', async () => {
      expect(await registerHumanReply(adaptation, CHAT)).toBe(true);

      const lines = (await fs.readFile(handoffFile, 'utf8')).trim().split('\n');
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]!)).toMatchObject({ a: 'delafonte', c: CHAT });
      expect(store.size).toBe(0);

      resetHandoffStoreForTests();
      jest.spyOn(RedisConfig, 'isReady').mockReturnValue(false);
      expect((await intercept(adaptation, 'reservar')).action).toBe('silence');
    });

    it('cada mensaje suyo no agrega otra línea', async () => {
      expect(await registerHumanReply(adaptation, CHAT)).toBe(true);
      expect(await registerHumanReply(adaptation, CHAT)).toBe(false);
      expect(await registerHumanReply(adaptation, CHAT)).toBe(false);

      const lines = (await fs.readFile(handoffFile, 'utf8')).trim().split('\n');
      expect(lines).toHaveLength(1);
    });

    it('el silencio es de ese chat, no del comercio', async () => {
      await registerHumanReply(adaptation, CHAT);

      expect(await intercept(adaptation, 'hola', OTHER_CHAT)).toEqual({ action: 'continue' });
    });
  });

  describe('isBotMuted (el chequeo después de que el modelo contesta)', () => {
    it.each([antigalAdaptation, skyAdaptation, laMisionAdaptation, deLaFonteAdaptation])(
      '$id: sólo cuando corresponde',
      async (adaptation) => {
        expect(await isBotMuted(adaptation, CHAT)).toBe(false);

        await registerHumanReply(adaptation, CHAT);

        expect(await isBotMuted(adaptation, CHAT)).toBe(true);
        expect(await isBotMuted(adaptation, OTHER_CHAT)).toBe(false);
      }
    );

    it('también con un traspaso pedido por el cliente', async () => {
      await handOffWithoutReply(antigalAdaptation, CHAT);

      expect(await isBotMuted(antigalAdaptation, CHAT)).toBe(true);
    });
  });
});

/**
 * "Si alguien escribe para no hacer reserva y para hablar con la persona, que
 * el bot ya no le conteste." La palabra del menú sola sigue confirmando (es la
 * respuesta al saludo que el local acordó); nombrar a la persona en medio de
 * otra cosa es hablarle a ELLA, y el bot se corre sin decir nada.
 */
describe('nombrar a la persona sin hablarle al bot', () => {
  let store: Map<string, string>;

  beforeEach(async () => {
    jest.restoreAllMocks();
    store = new Map();
    resetHandoffStoreForTests();
    process.env.SHARED_NUMBER_HANDOFF_FILE = path.join(
      await fs.mkdtemp(path.join(os.tmpdir(), 'handoffs-')),
      'h.jsonl'
    );

    jest.spyOn(RedisConfig, 'isReady').mockReturnValue(true);
    jest.spyOn(RedisConfig, 'getClient').mockReturnValue({
      get: jest.fn(async (key: string) => store.get(key) ?? null),
      setEx: jest.fn(async (key: string, _ttl: number, value: string) => {
        store.set(key, value);
        return 'OK';
      }),
      del: jest.fn(async (key: string) => (store.delete(key) ? 1 : 0)),
    } as any);
  });

  afterEach(() => {
    delete process.env.SHARED_NUMBER_HANDOFF_FILE;
  });

  describe('De La Fonte — mensajes reales de los logs', () => {
    it.each([
      'Hola Simona!!! Muy buenos días',
      'Buen día Simona! Cómo estás? Espero que bien! Te quería comentar, por si te sirve, tengo una acción para el día de la madre',
      'Hola buenas tardes Simona como estas',
      'Buenas tardes Sra Simona.',
      'Dale Simona gracias',
    ])('"%s": se corre sin decir nada y el chat queda para ella', async (text) => {
      expect(await intercept(deLaFonteAdaptation, text)).toEqual({
        action: 'silence',
        reason: 'handoff',
      });
      // Y es el mismo traspaso permanente de siempre.
      expect((await intercept(deLaFonteAdaptation, 'reservar')).action).toBe('silence');
    });

    it.each([
      'PERSONAL',
      'personal',
      'Simona',
      'simona!',
      'quiero hablar con Simona',
      'hola, quería hablar con la dueña por un cumpleaños',
      'Necesito hablar con la encargada',
    ])('"%s" le habla al bot: confirma antes de callarse', async (text) => {
      const outcome = await intercept(deLaFonteAdaptation, text);

      expect(outcome.action).toBe('reply');
      expect(outcome.action === 'reply' && outcome.text).toContain('De La Fonte');
    });
  });

  describe('Antigal', () => {
    it.each(['Hola Vale! ¿cómo andás?', 'Valentina te paso el presupuesto', 'gracias vale!!'])(
      '"%s": se corre sin decir nada',
      async (text) => {
        expect(await intercept(antigalAdaptation, text)).toEqual({
          action: 'silence',
          reason: 'handoff',
        });
        expect((await intercept(antigalAdaptation, 'hola?')).action).toBe('silence');
      }
    );

    it.each(['Valentina', 'VALENTINA', 'quiero hablar con Valentina', 'Hola! Quiero hablar con Vale'])(
      '"%s" le habla al bot: confirma',
      async (text) => {
        const outcome = await intercept(antigalAdaptation, text);

        expect(outcome.action).toBe('reply');
        expect(outcome.action === 'reply' && outcome.text).toContain('Valentina');
      }
    );

    it('el traspaso silencioso sigue teniendo la salida de siempre: una palabra de reserva', async () => {
      await intercept(antigalAdaptation, 'Hola Vale! ¿cómo andás?');

      expect((await intercept(antigalAdaptation, 'quiero reservar una mesa')).action).toBe(
        'continue'
      );
    });
  });

  describe('SKY y La Misión (palabra exacta)', () => {
    it.each([
      [skyAdaptation, 'SKY'],
      [skyAdaptation, 'otra consulta'],
      [laMisionAdaptation, 'CONSULTAS'],
    ])('%#: la palabra del menú sigue confirmando', async (adaptation, text) => {
      expect((await intercept(adaptation, text)).action).toBe('reply');
    });

    it('pedir una reserva "en Sky" sigue sin canalizar', async () => {
      expect(await intercept(skyAdaptation, 'hola quiero reservar una mesa en Sky')).toEqual({
        action: 'continue',
      });
    });
  });

  it('el traspaso que decide el modelo deja el mismo silencio', async () => {
    await handOffWithoutReply(antigalAdaptation, CHAT, 'personal');

    expect(await intercept(antigalAdaptation, 'jaja dale')).toEqual({
      action: 'silence',
      reason: 'handoff',
    });
  });
});
