import { handleTurn } from '../../agent/orchestrator.js';
import { executeToolCall, getToolDefinitions } from '../../agent/tools/index.js';
import { skyAdaptation } from '../../adaptations/sky.js';
import { buildStaticPrompt } from '../../agent/system-prompt.js';
import { openRouterService } from '../../services/openrouter.service.js';
import { SupabaseService } from '../../services/supabase.service.js';
import { RedisConfig } from '../../config/redis.js';
import * as sharedNumber from '../../adaptations/shared-number.js';
import * as state from '../../agent/state.js';
import { antigalAdaptation } from '../../adaptations/antigal.js';
import { runWithLanguage } from '../../i18n/index.js';
import { LlmToolCall } from '../../types/index.js';

jest.mock('../../utils/logger');

/**
 * `hand_off_to_human`: lo que las palabras del menú no atrapan. El amigo que
 * escribe "holaa simo todo bien?" no escribe PERSONAL, y antes el modelo le
 * contestaba pidiéndoselo. Ahora puede dejar el chat en manos de la persona
 * sin decir nada — y el orquestador se asegura de que de verdad no se diga
 * nada, aunque el modelo intente despedirse.
 */

const BUSINESS_ID = '00000000-0000-0000-0000-0000000000bb';
const PHONE = '5491155550000';
const CONVERSATION_ID = `${BUSINESS_ID}-${PHONE}`;
const HUMAN_CONTEXT = antigalAdaptation.humanContext;

const CTX = {
  businessId: BUSINESS_ID,
  conversationId: CONVERSATION_ID,
  phone: PHONE,
  jid: `${PHONE}@s.whatsapp.net`,
  language: 'es' as const,
};

function handOffCall(reason = 'personal'): LlmToolCall {
  return {
    id: 'h1',
    type: 'function',
    function: { name: 'hand_off_to_human', arguments: JSON.stringify({ reason }) },
  };
}

function turn(messageText: string, humanContext?: string, dryRun = false) {
  return runWithLanguage('es', () =>
    handleTurn({ ...CTX, messageText, businessName: 'Antigal', humanContext, dryRun })
  );
}

describe('derivar a la persona del local (hand_off_to_human)', () => {
  let redis: Map<string, string>;

  beforeEach(() => {
    jest.restoreAllMocks();
    redis = new Map();
    process.env.ANTIGAL_BUSINESS_ID = BUSINESS_ID;

    jest.spyOn(RedisConfig, 'isReady').mockReturnValue(true);
    jest.spyOn(RedisConfig, 'getClient').mockReturnValue({
      get: jest.fn(async (key: string) => redis.get(key) ?? null),
      setEx: jest.fn(async (key: string, _ttl: number, value: string) => {
        redis.set(key, value);
        return 'OK';
      }),
      del: jest.fn(async (key: string) => (redis.delete(key) ? 1 : 0)),
    } as any);

    jest.spyOn(SupabaseService, 'getBusinessById').mockResolvedValue({
      id: BUSINESS_ID,
      name: 'Antigal',
      weekly_hours: {},
    } as any);
    jest.spyOn(SupabaseService, 'getBlockedDates').mockResolvedValue(new Map());
    jest.spyOn(SupabaseService, 'getCustomerByPhone').mockResolvedValue(null);
    jest.spyOn(SupabaseService, 'getActiveReservationsByPhone').mockResolvedValue([]);
    jest.spyOn(SupabaseService, 'getActiveEvents').mockResolvedValue([]);
    jest.spyOn(state, 'loadHistory').mockResolvedValue([]);
    jest.spyOn(state, 'saveHistory').mockResolvedValue();
  });

  afterEach(() => {
    delete process.env.ANTIGAL_BUSINESS_ID;
  });

  describe('qué se le ofrece al modelo', () => {
    it('por defecto no existe: en un número que atiende sólo el bot no hay a quién derivar', () => {
      const names = getToolDefinitions().map((d) => d.function.name);

      expect(names).not.toContain('hand_off_to_human');
    });

    it('en un número compartido va al final, sin mover el resto (prompt cache)', () => {
      const base = getToolDefinitions().map((d) => d.function.name);
      const shared = getToolDefinitions({ humanHandoff: true }).map((d) => d.function.name);

      expect(shared).toEqual([...base, 'hand_off_to_human']);
    });

    it('el prompt de un número compartido explica a quién derivar y que no se dice nada', () => {
      const prompt = runWithLanguage('es', () => buildStaticPrompt('Antigal', HUMAN_CONTEXT));

      expect(prompt).toContain('## Este número también lo atiende una persona');
      expect(prompt).toContain(HUMAN_CONTEXT);
      expect(prompt).toContain('hand_off_to_human');
      expect(prompt).toContain('no respondas nada');
      // Lo viejo, que era el bot metiéndose en la charla, ya no está.
      expect(prompt).not.toContain('decile que escriba');
    });

    it('con inquiryGuidance el cliente con una consulta ajena a la reserva se contesta, no se deriva', () => {
      const prompt = runWithLanguage('es', () =>
        buildStaticPrompt('SKY', HUMAN_CONTEXT, skyAdaptation.inquiryGuidance)
      );

      expect(prompt).toContain(skyAdaptation.inquiryGuidance);
      expect(prompt).toContain('NO se\nderiva en silencio');
      // Lo que no es del cliente sigue yendo en silencio.
      expect(prompt).toContain('proveedores');
      expect(prompt).toContain('hand_off_to_human');
      // Pedir hablar con una persona ya no es motivo de silencio: se le contesta.
      expect(prompt).not.toContain('Pide hablar con una persona, con el dueño');
    });

    it('sin inquiryGuidance el prompt es el mismo de siempre', () => {
      const prompt = runWithLanguage('es', () => buildStaticPrompt('Antigal', HUMAN_CONTEXT));

      expect(prompt).not.toContain('NO se\nderiva en silencio');
      expect(prompt).toContain('Pide hablar con una persona, con el dueño');
    });

    it('el prompt de un local común no cambia', () => {
      const prompt = runWithLanguage('es', () => buildStaticPrompt('La Parrilla'));

      expect(prompt).not.toContain('hand_off_to_human');
      expect(prompt).not.toContain('Este número también lo atiende una persona');
    });

    it('el orquestador ofrece la herramienta sólo si recibe el contexto del local', async () => {
      const loop = jest
        .spyOn(openRouterService, 'runToolLoop')
        .mockResolvedValue({ content: 'ok', executedToolCalls: [], messages: [], model: 'm', iterations: 1, exhausted: false });

      await turn('hola', HUMAN_CONTEXT);
      await turn('hola');

      const toolsWith = loop.mock.calls[0]![2].map((t) => t.function.name);
      const toolsWithout = loop.mock.calls[1]![2].map((t) => t.function.name);
      expect(toolsWith).toContain('hand_off_to_human');
      expect(toolsWithout).not.toContain('hand_off_to_human');
      expect(loop.mock.calls[0]![1]).toContain(HUMAN_CONTEXT);
    });
  });

  describe('cuando el modelo deriva', () => {
    function modelHandsOff(alsoWrites: string) {
      return jest
        .spyOn(openRouterService, 'runToolLoop')
        .mockImplementation(async (_m, _s, _t, executor) => {
          const output = await executor(handOffCall());
          return {
            content: alsoWrites,
            executedToolCalls: [{ name: 'hand_off_to_human', arguments: '{}', output }],
            messages: [],
            model: 'm',
            iterations: 2,
            exhausted: false,
          };
        });
    }

    it('no se manda nada, aunque el modelo haya escrito una despedida', async () => {
      modelHandsOff('¡Listo! Te paso con Valentina 😊');

      const result = await turn('Hola Vale! ¿Vamos al cine el sábado?', HUMAN_CONTEXT);

      expect(result.handedOff).toBe(true);
      expect(result.messages).toEqual([]);
      expect(result.attachments).toEqual([]);
    });

    it('la despedida que no se mandó tampoco queda en el historial', async () => {
      const save = jest.spyOn(state, 'saveHistory').mockResolvedValue();
      modelHandsOff('¡Listo! Te paso con Valentina 😊');

      await turn('Hola Vale!', HUMAN_CONTEXT);

      const persisted = save.mock.calls[0]![1];
      expect(persisted.some((m) => String(m.content).includes('Te paso con Valentina'))).toBe(false);
    });

    it('ni siquiera el mensaje genérico de "turno vacío"', async () => {
      modelHandsOff('');

      const result = await turn('Te paso las facturas', HUMAN_CONTEXT);

      expect(result.messages).toEqual([]);
    });

    it('deja el chat en silencio: el siguiente mensaje ya no lo atiende el bot', async () => {
      modelHandsOff('');

      await turn('Chicos mañana falto', HUMAN_CONTEXT);

      expect(
        await sharedNumber.interceptSharedNumberTurn(antigalAdaptation, CONVERSATION_ID, 'ok')
      ).toEqual({ action: 'silence', reason: 'handoff' });
    });

    it('en dry-run no escribe nada', async () => {
      const handOff = jest.spyOn(sharedNumber, 'handOffWithoutReply');
      modelHandsOff('');

      const result = await turn('Hola Vale!', HUMAN_CONTEXT, true);

      expect(result.handedOff).toBe(true);
      expect(handOff).not.toHaveBeenCalled();
      expect(redis.size).toBe(0);
    });
  });

  describe('la herramienta', () => {
    it('registra el traspaso con el motivo que dio el modelo', async () => {
      const handOff = jest.spyOn(sharedNumber, 'handOffWithoutReply');

      const result = await executeToolCall(handOffCall('business'), CTX);

      expect(result).toMatchObject({ ok: true, data: { handedOff: true } });
      expect(handOff).toHaveBeenCalledWith(antigalAdaptation, CONVERSATION_ID, 'business');
    });

    it('un motivo inventado se registra como "other"', async () => {
      const handOff = jest.spyOn(sharedNumber, 'handOffWithoutReply');

      await executeToolCall(handOffCall('cualquier cosa'), CTX);

      expect(handOff).toHaveBeenCalledWith(antigalAdaptation, CONVERSATION_ID, 'other');
    });

    it('en un local sin número compartido falla y el turno sigue normal', async () => {
      delete process.env.ANTIGAL_BUSINESS_ID;
      jest.spyOn(openRouterService, 'runToolLoop').mockImplementation(async (_m, _s, _t, executor) => {
        const output = await executor(handOffCall());
        return {
          content: '¿Para cuántas personas?',
          executedToolCalls: [{ name: 'hand_off_to_human', arguments: '{}', output }],
          messages: [],
          model: 'm',
          iterations: 2,
          exhausted: false,
        };
      });

      const result = await turn('quiero reservar');

      expect(result.handedOff).toBeUndefined();
      expect(result.messages).toEqual(['¿Para cuántas personas?']);
    });
  });
});
