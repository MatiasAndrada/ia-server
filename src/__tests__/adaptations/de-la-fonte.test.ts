import { RedisConfig } from '../../config/redis.js';
import {
  interceptSharedNumberTurn,
  isSharedNumberBusiness,
  sharedNumberWelcome,
} from '../../adaptations/de-la-fonte.js';

jest.mock('../../utils/logger');

/**
 * El número de De La Fonte lo comparten el bot y Simona, la dueña. Lo que se
 * verifica acá es el interruptor entre los dos: quién queda callado, cuándo, y
 * qué lo trae de vuelta.
 */

const BUSINESS_ID = '00000000-0000-0000-0000-000000000009';
const CONVERSATION_ID = `${BUSINESS_ID}-5491155551234`;

describe('adaptación De La Fonte', () => {
  /** Redis simulado con un Map: el traspaso es una key con TTL y nada más. */
  let store: Map<string, string>;

  beforeEach(() => {
    jest.restoreAllMocks();
    store = new Map();
    delete process.env.DE_LA_FONTE_BUSINESS_ID;

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

  describe('a qué comercios aplica', () => {
    it('reconoce el comercio por su nombre, sin configurar nada', () => {
      // El fallback por nombre es lo que permite desplegar esto sin tocar el
      // .env del servidor.
      expect(isSharedNumberBusiness(BUSINESS_ID, 'De La Fonte')).toBe(true);
      expect(isSharedNumberBusiness(BUSINESS_ID, 'Restaurante De La Fonte')).toBe(true);
    });

    it('lo reconoce por el id configurado, aunque el nombre no coincida', () => {
      process.env.DE_LA_FONTE_BUSINESS_ID = `otro-id, ${BUSINESS_ID}`;

      expect(isSharedNumberBusiness(BUSINESS_ID, 'Trattoria Sin Nombre')).toBe(true);
    });

    it('NO se aplica a cualquier otro comercio', () => {
      expect(isSharedNumberBusiness('otro-id', 'La Parrilla')).toBe(false);
      expect(isSharedNumberBusiness('otro-id', null)).toBe(false);
    });
  });

  describe('canalizar a Simona', () => {
    it('confirma el traspaso cuando el cliente escribe la palabra del menú', async () => {
      const outcome = await interceptSharedNumberTurn(CONVERSATION_ID, 'Simona');

      expect(outcome.action).toBe('reply');
      expect(outcome.action === 'reply' && outcome.text).toContain('Simona');
      // El mensaje tiene que decir cuál es la palabra que trae al bot de vuelta,
      // o el cliente queda sin salida del silencio.
      expect(outcome.action === 'reply' && outcome.text).toContain('Reservar');
    });

    it('entiende el pedido en una frase, no sólo la palabra suelta', async () => {
      const outcome = await interceptSharedNumberTurn(
        CONVERSATION_ID,
        'hola, quería hablar con la dueña por un cumpleaños'
      );

      expect(outcome.action).toBe('reply');
    });

    it('después del traspaso el bot no contesta más', async () => {
      await interceptSharedNumberTurn(CONVERSATION_ID, 'Simona');

      // Todo lo que sigue es conversación con ella: el bot no aparece.
      expect((await interceptSharedNumberTurn(CONVERSATION_ID, 'hola?')).action).toBe('silence');
      expect(
        (await interceptSharedNumberTurn(CONVERSATION_ID, 'era para el sábado a la noche')).action
      ).toBe('silence');
      expect((await interceptSharedNumberTurn(CONVERSATION_ID, 'gracias!')).action).toBe('silence');
    });

    it('el silencio es de esa conversación, no del comercio entero', async () => {
      await interceptSharedNumberTurn(CONVERSATION_ID, 'Simona');

      const otraConversacion = `${BUSINESS_ID}-5491199998888`;
      expect((await interceptSharedNumberTurn(otraConversacion, 'hola')).action).toBe('continue');
    });
  });

  describe('volver al bot', () => {
    beforeEach(async () => {
      await interceptSharedNumberTurn(CONVERSATION_ID, 'Simona');
    });

    it.each(['reservar', 'quiero reservar una mesa', 'necesito una mesa para 4', 'cancelar mi reserva'])(
      'reactiva con "%s" y ese mismo mensaje ya lo atiende el bot',
      async (text) => {
        const outcome = await interceptSharedNumberTurn(CONVERSATION_ID, text);

        // 'continue', no 'reply': el mensaje que reactiva sigue al flujo normal,
        // que es lo que espera alguien que acaba de pedir una mesa.
        expect(outcome.action).toBe('continue');
      }
    );

    it('una vez reactivado sigue atendiendo normalmente', async () => {
      await interceptSharedNumberTurn(CONVERSATION_ID, 'reservar');

      expect((await interceptSharedNumberTurn(CONVERSATION_ID, 'para el viernes')).action).toBe(
        'continue'
      );
    });

    it('pedir de nuevo por Simona lo vuelve a silenciar', async () => {
      await interceptSharedNumberTurn(CONVERSATION_ID, 'reservar');

      expect((await interceptSharedNumberTurn(CONVERSATION_ID, 'mejor hablo con Simona')).action).toBe(
        'reply'
      );
      expect((await interceptSharedNumberTurn(CONVERSATION_ID, 'hola')).action).toBe('silence');
    });
  });

  describe('degradación', () => {
    it('con Redis caído contesta el bot en vez de quedar mudo', async () => {
      jest.spyOn(RedisConfig, 'isReady').mockReturnValue(false);

      // No se puede saber si hay un traspaso activo. Entre dejar sin respuesta a
      // alguien que quería reservar y que el bot hable de más, gana lo segundo.
      expect((await interceptSharedNumberTurn(CONVERSATION_ID, 'hola')).action).toBe('continue');
    });
  });

  describe('saludo del número compartido', () => {
    it('anuncia que el número es compartido y los dos caminos', () => {
      const menu = sharedNumberWelcome(null, []);

      expect(menu).toContain('compartido');
      expect(menu).toContain('Simona');
      expect(menu).toContain('Reservar');
    });

    it('saluda por su nombre al cliente conocido', () => {
      expect(sharedNumberWelcome('Matías', [])).toContain('¡Hola, Matías!');
    });

    it('lista los eventos vigentes, y sin eventos no muestra la sección', () => {
      const conEventos = sharedNumberWelcome(null, [
        { title: 'Noche de Jazz', whenLabel: 'el sábado' },
      ]);
      expect(conEventos).toContain('Próximos eventos');
      expect(conEventos).toContain('Noche de Jazz');

      expect(sharedNumberWelcome(null, [])).not.toContain('Próximos eventos');
    });
  });
});
