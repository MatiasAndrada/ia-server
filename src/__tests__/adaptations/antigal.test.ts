import { RedisConfig } from '../../config/redis.js';
import { antigalAdaptation } from '../../adaptations/antigal.js';
import { findSharedNumberAdaptation, interceptSharedNumberTurn } from '../../adaptations/index.js';

jest.mock('../../utils/logger');

/**
 * Antigal comparte el número con Valentina. A diferencia de De La Fonte el
 * traspaso no es permanente: silencio de cuarenta y ocho horas con salida por
 * palabra de reserva, que es el comportamiento por defecto del motor.
 */

const BUSINESS_ID = 'd4597a2e-16e4-4348-b3da-73f4308a2ce6';
const CONVERSATION_ID = `${BUSINESS_ID}-5491155557777`;

const intercept = (text: string) =>
  interceptSharedNumberTurn(antigalAdaptation, CONVERSATION_ID, text);

describe('adaptación Antigal', () => {
  let store: Map<string, string>;
  let setEx: jest.Mock;

  beforeEach(() => {
    jest.restoreAllMocks();
    store = new Map();
    delete process.env.ANTIGAL_BUSINESS_ID;
    delete process.env.SKY_BUSINESS_ID;
    delete process.env.LA_MISION_BUSINESS_ID;
    delete process.env.DE_LA_FONTE_BUSINESS_ID;

    setEx = jest.fn(async (key: string, _ttl: number, value: string) => {
      store.set(key, value);
      return 'OK';
    });
    jest.spyOn(RedisConfig, 'isReady').mockReturnValue(true);
    jest.spyOn(RedisConfig, 'getClient').mockReturnValue({
      get: jest.fn(async (key: string) => store.get(key) ?? null),
      setEx,
      del: jest.fn(async (key: string) => (store.delete(key) ? 1 : 0)),
    } as any);
  });

  describe('a qué comercios aplica', () => {
    it('lo reconoce por el id configurado', () => {
      process.env.ANTIGAL_BUSINESS_ID = BUSINESS_ID;

      expect(findSharedNumberAdaptation(BUSINESS_ID)).toBe(antigalAdaptation);
    });

    it('sin el id configurado, NO se aplica', () => {
      expect(findSharedNumberAdaptation(BUSINESS_ID)).toBeNull();
    });
  });

  describe('hablar con Valentina', () => {
    it.each(['Valentina', 'valentina', 'quiero hablar con Valentina'])(
      'canaliza con "%s"',
      async (text) => {
        const outcome = await intercept(text);

        expect(outcome.action).toBe('reply');
        expect(outcome.action === 'reply' && outcome.text).toContain('Reservar');
      }
    );

    it('el traspaso no es permanente: vence a las cuarenta y ocho horas', async () => {
      await intercept('Valentina');

      expect(setEx).toHaveBeenCalledWith(expect.any(String), 48 * 60 * 60, '1');
    });

    it('después del traspaso el bot no contesta más', async () => {
      await intercept('Valentina');

      expect((await intercept('hola?')).action).toBe('silence');
    });

    it('"reservar" a secas no canaliza', async () => {
      expect((await intercept('Reservar')).action).toBe('continue');
    });
  });

  describe('volver al bot', () => {
    beforeEach(async () => {
      await intercept('Valentina');
    });

    it.each(['Reservar', 'quiero reservar una mesa', 'necesito una mesa para 4'])(
      'reactiva con "%s" y ese mismo mensaje ya lo atiende el bot',
      async (text) => {
        expect((await intercept(text)).action).toBe('continue');
        expect((await intercept('hola')).action).toBe('continue');
      }
    );
  });

  describe('saludo del número compartido', () => {
    const welcome = (
      name: string | null = 'Daniel',
      events: { title: string; whenLabel: string }[] = []
    ) => antigalAdaptation.welcome(name, events);

    it('reproduce el template acordado con un evento', () => {
      expect(
        welcome('Daniel', [{ title: 'Noche de Sushi', whenLabel: 'viernes 25/09 · 20:30' }])
      ).toBe(
        [
          'Hola, Daniel! 👋',
          '',
          'Bienvenido/a a Antigal Parrilla Restaurante',
          '',
          '📱 Este número es compartido, así que decime qué necesitás:',
          '',
          '🗣️ Hablar con Valentina → escribí Valentina',
          '📅 Reservar en el Restaurante → escribí Reservar',
          '',
          '✨ Próximos eventos:',
          '',
          '* Noche de Sushi · Viernes 25/09 · 20:30',
          '',
          '🎟️ Para reservar en el evento, escribí Noche de Sushi.',
        ].join('\n')
      );
    });

    it('sin eventos no muestra nada de esa sección', () => {
      const menu = welcome('Daniel');

      expect(menu).not.toContain('evento');
      expect(menu).not.toContain('✨');
      expect(menu).not.toContain('🎟️');
      expect(menu.endsWith('escribí Reservar')).toBe(true);
    });

    it('sin nombre saluda sin coma', () => {
      expect(welcome(null).startsWith('Hola! 👋\n')).toBe(true);
    });

    it('con varios eventos los lista y pide el nombre, sin elegir por el cliente', () => {
      const menu = welcome('Daniel', [
        { title: 'Noche de Sushi', whenLabel: 'viernes 25/09 · 20:30' },
        { title: 'Cata de vinos', whenLabel: 'sábado 26/09 · 21:00' },
      ]);

      expect(menu).toContain('* Noche de Sushi · Viernes 25/09 · 20:30');
      expect(menu).toContain('* Cata de vinos · Sábado 26/09 · 21:00');
      expect(menu).toContain('🎟️ Para reservar en un evento, escribí el nombre del evento.');
    });
  });
});
