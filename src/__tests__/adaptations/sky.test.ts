import { RedisConfig } from '../../config/redis.js';
import { deLaFonteAdaptation } from '../../adaptations/de-la-fonte.js';
import { skyAdaptation } from '../../adaptations/sky.js';
import { findSharedNumberAdaptation, interceptSharedNumberTurn } from '../../adaptations/index.js';

jest.mock('../../utils/logger');

/**
 * SKY comparte su número entre el bot de reservas y todo lo demás que le llega
 * al local. El mecanismo es el mismo que en De La Fonte y se prueba allá; lo
 * que importa acá es lo propio de este local, y sobre todo el riesgo que trae
 * su configuración: la palabra que canaliza es el NOMBRE del restaurante, así
 * que hay que asegurarse de que pedir una reserva "en Sky" no calle al bot.
 */

const BUSINESS_ID = '00000000-0000-0000-0000-000000000042';
const CONVERSATION_ID = `${BUSINESS_ID}-5491155559999`;

const intercept = (conversationId: string, text: string) =>
  interceptSharedNumberTurn(skyAdaptation, conversationId, text);

describe('adaptación SKY', () => {
  let store: Map<string, string>;

  beforeEach(() => {
    jest.restoreAllMocks();
    store = new Map();
    delete process.env.SKY_BUSINESS_ID;
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
      expect(findSharedNumberAdaptation(BUSINESS_ID, 'SKY Restaurante and Bar')).toBe(skyAdaptation);
      expect(findSharedNumberAdaptation(BUSINESS_ID, 'sky')).toBe(skyAdaptation);
    });

    it('lo reconoce por el id configurado, aunque el nombre no coincida', () => {
      process.env.SKY_BUSINESS_ID = BUSINESS_ID;

      expect(findSharedNumberAdaptation(BUSINESS_ID, 'Rooftop Sin Nombre')).toBe(skyAdaptation);
    });

    it('"sky" se busca como palabra, no como pedazo de otra', () => {
      // Tres letras sueltas dentro de un nombre ajeno silenciarían un bot que
      // no tiene nada que ver con esto.
      expect(findSharedNumberAdaptation('otro-id', 'Whiskey House')).toBeNull();
      expect(findSharedNumberAdaptation('otro-id', 'Skyline Pizzas')).toBeNull();
    });

    it('cada local cae en su propia adaptación', () => {
      expect(findSharedNumberAdaptation(BUSINESS_ID, 'De La Fonte')).toBe(deLaFonteAdaptation);
      expect(findSharedNumberAdaptation('otro-id', 'La Parrilla')).toBeNull();
    });
  });

  describe('canalizar al local', () => {
    it('canaliza cuando el mensaje es la palabra del menú', async () => {
      const outcome = await intercept(CONVERSATION_ID, 'SKY');

      expect(outcome.action).toBe('reply');
      // El mensaje tiene que decir con qué vuelve el bot, o el cliente queda
      // sin salida del silencio.
      expect(outcome.action === 'reply' && outcome.text).toContain('Reserva');
    });

    it.each(['consulta', 'info', 'otro tipo de consulta', 'Información'])(
      'también canaliza con "%s"',
      async (text) => {
        expect((await intercept(CONVERSATION_ID, text)).action).toBe('reply');
      }
    );

    it('después del traspaso el bot no contesta más', async () => {
      await intercept(CONVERSATION_ID, 'SKY');

      expect((await intercept(CONVERSATION_ID, 'hola?')).action).toBe('silence');
      expect((await intercept(CONVERSATION_ID, 'quería consultar por un cumpleaños')).action).toBe(
        'silence'
      );
    });
  });

  /**
   * El caso que justifica que SKY exija el mensaje exacto: su palabra de
   * canalización es la misma que la gente escribe para reservar.
   */
  describe('el nombre del local dentro de una frase NO canaliza', () => {
    it.each([
      'hola, quiero reservar en Sky para 4',
      'una mesa en sky el viernes',
      'me recomendaron Sky, están abiertos hoy?',
      'sky rooftop',
    ])('"%s" sigue al flujo normal', async (text) => {
      expect((await intercept(CONVERSATION_ID, text)).action).toBe('continue');
    });
  });

  describe('volver al bot', () => {
    beforeEach(async () => {
      await intercept(CONVERSATION_ID, 'SKY');
    });

    it.each(['reserva', 'quiero reservar una mesa', 'necesito una mesa para 4', 'cancelar mi reserva'])(
      'reactiva con "%s" y ese mismo mensaje ya lo atiende el bot',
      async (text) => {
        expect((await intercept(CONVERSATION_ID, text)).action).toBe('continue');
      }
    );

    it('el silencio de SKY no calla al bot de De La Fonte', async () => {
      // Cada adaptación tiene su propio espacio de keys: un traspaso en un local
      // no puede apagar el bot del otro.
      const outcome = await interceptSharedNumberTurn(
        deLaFonteAdaptation,
        CONVERSATION_ID,
        'hola'
      );

      expect(outcome.action).toBe('continue');
    });
  });

  describe('saludo del número compartido', () => {
    const welcome = (name: string | null, events: { title: string; whenLabel: string }[] = []) =>
      skyAdaptation.welcome(name, events);

    it('ofrece los dos caminos con la palabra exacta de cada uno', () => {
      const menu = welcome(null);

      expect(menu).toContain('SKY Restaurante and Bar');
      expect(menu).toContain('escribí *Reserva*');
      expect(menu).toContain('escribí *SKY*');
    });

    it('saluda por su nombre al cliente conocido', () => {
      expect(welcome('Matías')).toContain('¡Hola, Matías!');
    });

    it('con un solo evento lo nombra, que es más fácil de contestar', () => {
      const menu = welcome(null, [{ title: 'Noche de Pastas', whenLabel: 'viernes 21:00' }]);

      expect(menu).toContain('nuestro próximo evento');
      expect(menu).toContain('Noche de Pastas · Viernes 21:00');
      expect(menu).toContain('→ Escribí *Noche de Pastas* para reservar tu lugar.');
    });

    it('con varios eventos pide el nombre, porque no puede elegir por el cliente', () => {
      const menu = welcome(null, [
        { title: 'Noche de Pastas', whenLabel: 'viernes 21:00' },
        { title: 'Cata de vinos', whenLabel: 'sábado 20:30' },
      ]);

      expect(menu).toContain('nuestros próximos eventos');
      expect(menu).toContain('Cata de vinos');
      expect(menu).toContain('→ Escribí el nombre del evento para reservar tu lugar.');
    });

    it('sin eventos no muestra la sección', () => {
      expect(welcome(null)).not.toContain('evento');
    });
  });
});
