import { RedisConfig } from '../../config/redis.js';
import { deLaFonteAdaptation } from '../../adaptations/de-la-fonte.js';
import { findSharedNumberAdaptation, interceptSharedNumberTurn } from '../../adaptations/index.js';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { removePermanentHandoff, resetHandoffStoreForTests } from '../../adaptations/handoff-store.js';

jest.mock('../../utils/logger');

/**
 * El número de De La Fonte lo comparten el bot y Simona, la dueña. Lo que se
 * verifica acá es el interruptor entre los dos: quién queda callado, cuándo, y
 * qué lo trae de vuelta.
 */

const BUSINESS_ID = '00000000-0000-0000-0000-000000000009';
const CONVERSATION_ID = `${BUSINESS_ID}-5491155551234`;

const intercept = (conversationId: string, text: string) =>
  interceptSharedNumberTurn(deLaFonteAdaptation, conversationId, text);

describe('adaptación De La Fonte', () => {
  /** Redis simulado con un Map: el traspaso es una key y nada más. */
  let store: Map<string, string>;
  /** Vencimientos pedidos por key; una key sin entrada acá no vence nunca. */
  let ttls: Map<string, number>;
  /** Archivo real de traspasos, en un directorio temporal por test. */
  let handoffFile: string;

  beforeEach(async () => {
    jest.restoreAllMocks();
    store = new Map();
    ttls = new Map();
    resetHandoffStoreForTests();
    handoffFile = path.join(
      await fs.mkdtemp(path.join(os.tmpdir(), 'handoffs-')),
      'nested',
      'handoffs.jsonl'
    );
    process.env.SHARED_NUMBER_HANDOFF_FILE = handoffFile;
    delete process.env.DE_LA_FONTE_BUSINESS_ID;
    delete process.env.SKY_BUSINESS_ID;

    jest.spyOn(RedisConfig, 'isReady').mockReturnValue(true);
    jest.spyOn(RedisConfig, 'getClient').mockReturnValue({
      get: jest.fn(async (key: string) => store.get(key) ?? null),
      set: jest.fn(async (key: string, value: string) => {
        store.set(key, value);
        return 'OK';
      }),
      setEx: jest.fn(async (key: string, ttl: number, value: string) => {
        store.set(key, value);
        ttls.set(key, ttl);
        return 'OK';
      }),
      del: jest.fn(async (key: string) => (store.delete(key) ? 1 : 0)),
    } as any);
  });

  describe('a qué comercios aplica', () => {
    it('lo reconoce por el id configurado', () => {
      process.env.DE_LA_FONTE_BUSINESS_ID = `otro-id, ${BUSINESS_ID}`;

      expect(findSharedNumberAdaptation(BUSINESS_ID)).toBe(deLaFonteAdaptation);
    });

    it('sin el id configurado, NO se aplica aunque el nombre coincida', () => {
      expect(findSharedNumberAdaptation(BUSINESS_ID)).toBeNull();
    });

    it('NO se aplica a cualquier otro comercio', () => {
      expect(findSharedNumberAdaptation('otro-id')).toBeNull();
    });
  });

  describe('canalizar a atención personalizada', () => {
    it('confirma el traspaso cuando el cliente escribe la palabra del menú', async () => {
      const outcome = await intercept(CONVERSATION_ID, 'PERSONAL');

      expect(outcome.action).toBe('reply');
      expect(outcome.action === 'reply' && outcome.text).toContain('De La Fonte');
      expect(outcome.action === 'reply' && outcome.text).not.toContain('Simona');
      // No hay salida del silencio, así que el mensaje no la promete.
      expect(outcome.action === 'reply' && outcome.text).not.toContain('Reservar');
    });

    it('la palabra vieja del menú ("Simona") sigue canalizando, para no romper hábitos', async () => {
      const outcome = await intercept(CONVERSATION_ID, 'Simona');

      expect(outcome.action).toBe('reply');
    });

    it('entiende el pedido en una frase, no sólo la palabra suelta', async () => {
      const outcome = await intercept(
        CONVERSATION_ID,
        'hola, quería hablar con la dueña por un cumpleaños'
      );

      expect(outcome.action).toBe('reply');
    });

    it('después del traspaso el bot no contesta más', async () => {
      await intercept(CONVERSATION_ID, 'Simona');

      // Todo lo que sigue es conversación con ella: el bot no aparece.
      expect((await intercept(CONVERSATION_ID, 'hola?')).action).toBe('silence');
      expect((await intercept(CONVERSATION_ID, 'era para el sábado a la noche')).action).toBe(
        'silence'
      );
      expect((await intercept(CONVERSATION_ID, 'gracias!')).action).toBe('silence');
    });

    it('el silencio es de esa conversación, no del comercio entero', async () => {
      await intercept(CONVERSATION_ID, 'Simona');

      const otraConversacion = `${BUSINESS_ID}-5491199998888`;
      expect((await intercept(otraConversacion, 'hola')).action).toBe('continue');
    });
  });

  describe('el bot nunca vuelve a activarse en ese chat', () => {
    beforeEach(async () => {
      await intercept(CONVERSATION_ID, 'Simona');
    });

    it.each([
      'reservar',
      'quiero reservar una mesa',
      'necesito una mesa para 4',
      'cancelar mi reserva',
      'turno',
      'hola',
    ])('"%s" no lo reactiva', async (text) => {
      expect((await intercept(CONVERSATION_ID, text)).action).toBe('silence');
    });

    it('pedir de nuevo por Simona tampoco genera otra respuesta del bot', async () => {
      expect((await intercept(CONVERSATION_ID, 'mejor hablo con Simona')).action).toBe('silence');
    });

    it('sigue en silencio aunque el cliente insista varias veces', async () => {
      for (const text of ['reservar', 'reservar', 'quiero una mesa', 'hola??']) {
        expect((await intercept(CONVERSATION_ID, text)).action).toBe('silence');
      }
    });
  });

  describe('sobrevive a un reinicio de Redis o del proceso', () => {
    beforeEach(async () => {
      await intercept(CONVERSATION_ID, 'Simona');
    });

    it('el traspaso queda escrito en el archivo local', async () => {
      const lines = (await fs.readFile(handoffFile, 'utf8')).trim().split('\n');

      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]!)).toMatchObject({ a: 'delafonte', c: CONVERSATION_ID });
    });

    it('no usa Redis para guardarlo', () => {
      expect(store.size).toBe(0);
      expect(ttls.size).toBe(0);
    });

    it('con Redis vaciado el bot sigue en silencio', async () => {
      store.clear();

      expect((await intercept(CONVERSATION_ID, 'quiero reservar una mesa')).action).toBe('silence');
    });

    it('con Redis caído sigue en silencio', async () => {
      jest.spyOn(RedisConfig, 'isReady').mockReturnValue(false);

      expect((await intercept(CONVERSATION_ID, 'reservar')).action).toBe('silence');
    });

    it('tras reiniciar el proceso (memoria vacía) lo recuerda desde el archivo', async () => {
      resetHandoffStoreForTests();

      expect((await intercept(CONVERSATION_ID, 'reservar')).action).toBe('silence');
    });

    it('pedir Simona dos veces no duplica la línea', async () => {
      await intercept(CONVERSATION_ID, 'Simona');
      resetHandoffStoreForTests();
      await intercept(CONVERSATION_ID, 'Simona');

      const lines = (await fs.readFile(handoffFile, 'utf8')).trim().split('\n');
      expect(lines).toHaveLength(1);
    });

    it('el silencio sigue siendo de esa conversación', async () => {
      resetHandoffStoreForTests();

      const otraConversacion = `${BUSINESS_ID}-5491199998888`;
      expect((await intercept(otraConversacion, 'hola')).action).toBe('continue');
    });

    it('si el archivo no se puede escribir, igual queda en silencio hasta el reinicio', async () => {
      // Un archivo donde debería haber un directorio hace fallar mkdir/append.
      const blocker = path.join(path.dirname(handoffFile), '..', 'blocker');
      await fs.writeFile(blocker, 'x');
      process.env.SHARED_NUMBER_HANDOFF_FILE = path.join(blocker, 'handoffs.jsonl');
      resetHandoffStoreForTests();
      const otra = `${BUSINESS_ID}-5491100000000`;

      await intercept(otra, 'Simona');

      expect((await intercept(otra, 'reservar')).action).toBe('silence');
    });
  });

  describe('levantar el silencio de un chat', () => {
    it('sin reiniciar: tras la baja el siguiente mensaje ya lo atiende el bot', async () => {
      await intercept(CONVERSATION_ID, 'Simona');
      expect((await intercept(CONVERSATION_ID, 'hola')).action).toBe('silence');

      await removePermanentHandoff('delafonte', CONVERSATION_ID);

      expect((await intercept(CONVERSATION_ID, 'hola')).action).toBe('continue');
    });
  });

  describe('degradación', () => {
    it('con Redis caído contesta el bot en vez de quedar mudo', async () => {
      jest.spyOn(RedisConfig, 'isReady').mockReturnValue(false);

      // No se puede saber si hay un traspaso activo. Entre dejar sin respuesta a
      // alguien que quería reservar y que el bot hable de más, gana lo segundo.
      expect((await intercept(CONVERSATION_ID, 'hola')).action).toBe('continue');
    });
  });

  describe('saludo del número compartido', () => {
    const welcome = (name: string | null, events: { title: string; whenLabel: string }[] = []) =>
      deLaFonteAdaptation.welcome(name, events);

    it('ofrece los dos caminos: atención personalizada o reservar', () => {
      const menu = welcome(null);

      expect(menu).toContain('De La Fonte');
      expect(menu).toContain('PERSONAL');
      expect(menu).toContain('RESERVAR');
      expect(menu).not.toContain('Simona');
    });

    it('saluda por su nombre al cliente conocido', () => {
      expect(welcome('Matías')).toContain('¡Hola, Matías!');
    });

    it('lista los eventos vigentes, y sin eventos no muestra la sección', () => {
      const conEventos = welcome(null, [{ title: 'Noche de Jazz', whenLabel: 'el sábado' }]);
      expect(conEventos).toContain('nuestro próximo evento');
      expect(conEventos).toContain('Noche de Jazz');
      expect(conEventos).toContain('→ Escribí *Noche de Jazz* para reservar tu lugar.');

      expect(welcome(null)).not.toContain('evento');
    });
  });
});
