import { RedisConfig } from '../../config/redis.js';
import { laMisionAdaptation } from '../../adaptations/la-mision.js';
import {
  findSharedNumberAdaptation,
  interceptSharedNumberTurn,
  markWelcomeMenuShown,
} from '../../adaptations/index.js';

jest.mock('../../utils/logger');

/**
 * La Misión comparte el número del hotel: el otro camino son las consultas
 * del hotel, no una persona con nombre ni "todo lo que no sea reservar". La
 * particularidad de este local es que su menú también se contesta por número
 * (1/2/3) — y eso sólo puede valer para la respuesta inmediata al saludo, ver
 * `handoffMenuDigit` en shared-number.ts.
 */

const BUSINESS_ID = '00000000-0000-0000-0000-000000000099';
const CONVERSATION_ID = `${BUSINESS_ID}-5491155557777`;

const intercept = (conversationId: string, text: string) =>
  interceptSharedNumberTurn(laMisionAdaptation, conversationId, text);

describe('adaptación La Misión', () => {
  let store: Map<string, string>;

  beforeEach(() => {
    jest.restoreAllMocks();
    store = new Map();
    delete process.env.LA_MISION_BUSINESS_ID;
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
    it('lo reconoce por el id configurado', () => {
      process.env.LA_MISION_BUSINESS_ID = BUSINESS_ID;

      expect(findSharedNumberAdaptation(BUSINESS_ID)).toBe(laMisionAdaptation);
    });

    it('sin el id configurado, NO se aplica', () => {
      expect(findSharedNumberAdaptation(BUSINESS_ID)).toBeNull();
    });
  });

  describe('canalizar al hotel', () => {
    it.each(['consultas', 'CONSULTAS', 'consulta'])(
      'canaliza cuando el mensaje es "%s"',
      async (text) => {
        const outcome = await intercept(CONVERSATION_ID, text);

        expect(outcome.action).toBe('reply');
        // El mensaje tiene que decir con qué vuelve el bot.
        expect(outcome.action === 'reply' && outcome.text).toContain('LA MISIÓN');
      }
    );

    it('después del traspaso el bot no contesta más', async () => {
      await intercept(CONVERSATION_ID, 'consultas');

      expect((await intercept(CONVERSATION_ID, 'hola?')).action).toBe('silence');
      expect((await intercept(CONVERSATION_ID, 'a qué hora es el check-in?')).action).toBe(
        'silence'
      );
    });
  });

  describe('el menú por número', () => {
    it('sin haberse mostrado el saludo, "1" suelto no canaliza', async () => {
      expect((await intercept(CONVERSATION_ID, '1')).action).toBe('continue');
    });

    it('recién mostrado el saludo, "1" canaliza igual que "CONSULTAS"', async () => {
      await markWelcomeMenuShown(laMisionAdaptation, CONVERSATION_ID);

      const outcome = await intercept(CONVERSATION_ID, '1');

      expect(outcome.action).toBe('reply');
    });

    it('el dígito sólo vale para ESE turno: el siguiente "1" ya no canaliza', async () => {
      await markWelcomeMenuShown(laMisionAdaptation, CONVERSATION_ID);

      await intercept(CONVERSATION_ID, '1'); // se consume acá y sí canaliza

      // Como canalizó, ahora está en silencio; sacamos el traspaso para probar
      // el caso relevante: un "1" posterior, sin marca activa, no debe volver a
      // canalizar aunque llegara a evaluarse (por ejemplo tras una reactivación).
      const outcomeDeNuevo = await intercept(CONVERSATION_ID, 'reservar una mesa');
      expect(outcomeDeNuevo.action).toBe('continue');

      expect((await intercept(CONVERSATION_ID, '1')).action).toBe('continue');
    });

    it('un turno intermedio que no sea el dígito también consume la marca', async () => {
      await markWelcomeMenuShown(laMisionAdaptation, CONVERSATION_ID);

      // El cliente contesta otra cosa primero (por ejemplo "2", que ya sigue al
      // flujo normal porque no matchea handoffPattern).
      expect((await intercept(CONVERSATION_ID, '2')).action).toBe('continue');

      // Un "1" en el turno siguiente ya no es la respuesta al saludo.
      expect((await intercept(CONVERSATION_ID, '1')).action).toBe('continue');
    });

    it('"2" y "3" nunca canalizan, se hayan mostrado o no el saludo', async () => {
      expect((await intercept(CONVERSATION_ID, '2')).action).toBe('continue');
      expect((await intercept(CONVERSATION_ID, '3')).action).toBe('continue');

      await markWelcomeMenuShown(laMisionAdaptation, CONVERSATION_ID);
      expect((await intercept(CONVERSATION_ID, '2')).action).toBe('continue');

      await markWelcomeMenuShown(laMisionAdaptation, CONVERSATION_ID);
      expect((await intercept(CONVERSATION_ID, '3')).action).toBe('continue');
    });
  });

  describe('volver al bot', () => {
    beforeEach(async () => {
      await intercept(CONVERSATION_ID, 'consultas');
    });

    it.each([
      'reservar',
      'quiero reservar una mesa',
      'necesito una mesa para 4',
      'cancelar mi reserva',
      'quiero ir a la misión',
    ])('reactiva con "%s" y ese mismo mensaje ya lo atiende el bot', async (text) => {
      expect((await intercept(CONVERSATION_ID, text)).action).toBe('continue');
    });

    it('un "1" NO reactiva: sólo las palabras clave lo hacen', async () => {
      expect((await intercept(CONVERSATION_ID, '1')).action).toBe('silence');
    });

    it('un "1" tampoco reactiva aunque justo se hubiera vuelto a marcar el saludo', async () => {
      // Caso límite: no debería pasar en el flujo real (no se manda saludo
      // estando en silencio), pero el contrato es que el dígito nunca reactiva
      // un traspaso activo, se consulte o no la marca.
      await markWelcomeMenuShown(laMisionAdaptation, CONVERSATION_ID);

      expect((await intercept(CONVERSATION_ID, '1')).action).toBe('silence');
    });
  });

  describe('saludo del número compartido', () => {
    const welcome = (events: { title: string; whenLabel: string }[] = []) =>
      laMisionAdaptation.welcome(null, events);

    it('ofrece las dos primeras opciones con su palabra y su número', () => {
      const menu = welcome();

      expect(menu).toContain('Gran Amérian Portal del Iguazú');
      expect(menu).toContain('Consultas sobre el hotel');
      expect(menu).toContain('Escribí CONSULTAS o respondé 1');
      expect(menu).toContain('Reservar en Restaurante La Misión');
      expect(menu).toContain('Escribí LA MISIÓN o respondé 2');
    });

    it('sin eventos no muestra la tercera opción', () => {
      expect(welcome()).not.toContain('evento');
      expect(welcome()).not.toContain('3️⃣');
    });

    it('con un solo evento lo ofrece también por número', () => {
      const menu = welcome([{ title: 'Noche de Sushi', whenLabel: 'viernes 25/09 · 20:30 h' }]);

      expect(menu).toContain('3️⃣ Próximos eventos');
      expect(menu).toContain('🍣 Noche de Sushi');
      expect(menu).toContain('📅 Viernes 25/09 · 20:30 h');
      expect(menu).toContain('Escribí NOCHE DE SUSHI o respondé 3 para reservar tu lugar.');
    });

    it('con varios eventos pide el nombre, sin número: no se puede elegir por el cliente', () => {
      const menu = welcome([
        { title: 'Noche de Sushi', whenLabel: 'viernes 25/09 · 20:30 h' },
        { title: 'Cata de vinos', whenLabel: 'sábado 26/09 · 21:00 h' },
      ]);

      expect(menu).toContain('Noche de Sushi');
      expect(menu).toContain('Cata de vinos');
      expect(menu).toContain('Escribí el nombre del evento para reservar tu lugar.');
      expect(menu).not.toContain('respondé 3');
    });
  });
});
