/**
 * Conversation Scenario Battery Runner
 *
 * Executes ALL scenarios from conversation-scenarios.ts against the real
 * WhatsAppHandler with mocked external services. Validates that the bot:
 *  - Never hallucinates
 *  - Stays on-topic
 *  - Respects the reservation flow
 *  - Handles abuse/vulgar messages gracefully
 *  - Correctly manages draft state
 */

import { WhatsAppHandler } from '../../services/whatsapp-handler.service';
import { SupabaseService } from '../../services/supabase.service';
import { ReservationService } from '../../services/reservation.service';
import { agentService } from '../../services/agent.service';
import { agentRegistry } from '../../agents';
import {
  ALL_SCENARIOS,
  ConversationScenario,
  getScenariosByCategory,
  ScenarioCategory,
} from '../scenarios/conversation-scenarios';
import {
  isGreetingOrReservationOptInMessage,
  buildReservationIntroMessage,
  evaluateReservationScope,
} from '../../utils/reservation-scope';

jest.mock('../../utils/logger');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface MockServices {
  sendMessage: jest.Mock<Promise<boolean>, [string, string, string]>;
  getSelfJid: jest.Mock<string | undefined, [string]>;
}

interface ScenarioRunContext {
  handler: WhatsAppHandler;
  mocks: MockServices;
  /** All messages the bot sent (in order) */
  botMessages: string[];
  /** Track whether the LLM was called per turn */
  llmCalled: boolean[];
  /** Track draft state after each turn */
  draftSteps: (string | null)[];
  /** Track reservation creation */
  reservationsCreated: boolean[];
}

const BUSINESS_ID = '00000000-0000-0000-0000-000000000001';
const PHONE = '5491155551234';
const JID = `${PHONE}@s.whatsapp.net`;

function buildMessage(text: string, idx: number) {
  return {
    from: JID,
    message: text,
    timestamp: Date.now() + idx * 1000,
    businessId: BUSINESS_ID,
    messageId: `msg-${idx}-${Math.random().toString(36).slice(2, 8)}`,
    fromMe: false,
  };
}

// ---------------------------------------------------------------------------
// Setup helpers
// ---------------------------------------------------------------------------

function setupMocks(scenario: ConversationScenario): ScenarioRunContext {
  jest.clearAllMocks();

  const mocks: MockServices = {
    sendMessage: jest.fn<Promise<boolean>, [string, string, string]>().mockResolvedValue(true),
    getSelfJid: jest.fn<string | undefined, [string]>().mockReturnValue(''),
  };

  const handler = new WhatsAppHandler(mocks as any);
  const botMessages: string[] = [];
  const llmCalled: boolean[] = [];
  const draftSteps: (string | null)[] = [];
  const reservationsCreated: boolean[] = [];

  // Track bot messages
  mocks.sendMessage.mockImplementation(async (_biz: string, _to: string, text: string) => {
    botMessages.push(text);
    return true;
  });

  // Business lookup
  jest.spyOn(SupabaseService, 'getBusinessById').mockResolvedValue({
    id: BUSINESS_ID,
    name: scenario.businessName ?? 'La Parrilla',
    whatsapp_session_id: 'session-active',
  } as any);

  // These scenarios exercise the reservation flow in Spanish, not the language
  // onboarding: model a customer who already settled on Spanish so the welcome
  // language menu isn't offered. `name` stays null so the name step still runs.
  // (The language menu itself is covered by src/__tests__/i18n/.)
  jest.spyOn(SupabaseService, 'getCustomerByPhone').mockResolvedValue({
    id: 'customer-test',
    phone: PHONE,
    business_id: BUSINESS_ID,
    name: null,
    lastName: null,
    preferred_language: 'es',
  } as any);
  jest.spyOn(SupabaseService, 'getCustomerLanguage').mockResolvedValue('es');
  jest.spyOn(SupabaseService, 'updateCustomerLanguage').mockResolvedValue(true);

  // Active reservation for the scenario
  const activeReservationData = scenario.activeReservation
    ? {
        id: scenario.activeReservation.id,
        status: scenario.activeReservation.status,
        display_code: scenario.activeReservation.displayCode,
        party_size: 4,
      }
    : null;

  jest
    .spyOn(SupabaseService, 'getActiveReservationByPhone')
    .mockResolvedValue(activeReservationData as any);

  jest
    .spyOn(SupabaseService, 'getActiveReservationsByPhone')
    .mockResolvedValue(activeReservationData ? [activeReservationData as any] : []);

  // Reservation status update
  jest.spyOn(SupabaseService, 'updateReservationStatus').mockResolvedValue(true);
  jest.spyOn(SupabaseService, 'updateReservationPartySize').mockResolvedValue(true);

  // Track reservation creation
  jest.spyOn(ReservationService, 'createReservation').mockImplementation(async () => {
    reservationsCreated.push(true);
    return {
      success: true,
      entry: {
        id: `entry-${Date.now()}`,
        display_code: `T${Math.floor(Math.random() * 1000)}`,
        party_size: 4,
        status: 'WAITING',
        customer_name: 'Test',
      },
      alreadyExists: false,
    } as any;
  });

  // Draft management — use real in-memory drafts
  const drafts = new Map<string, any>();

  jest.spyOn(ReservationService, 'getDraft').mockImplementation(async (convId: string) => {
    return drafts.get(convId) ?? null;
  });

  jest.spyOn(ReservationService, 'startReservation').mockImplementation(async (convId: string, bizId: string) => {
    const now = Date.now();
    const draft = {
      conversationId: convId,
      businessId: bizId,
      step: 'name' as const,
      createdAt: now,
      updatedAt: now,
      invalidAttempts: 0,
    };
    drafts.set(convId, draft);
    return draft;
  });

  jest.spyOn(ReservationService, 'setCustomerName').mockImplementation(async (convId: string, name: string) => {
    const draft = drafts.get(convId);
    if (draft) {
      draft.customerName = name;
      // Apellido is optional and is never asked for separately — advance straight to party_size.
      draft.step = 'party_size';
    }
    return draft;
  });

  jest.spyOn(ReservationService, 'setCustomerNameParts').mockImplementation(
    async (convId: string, name: string, lastName: string) => {
      const draft = drafts.get(convId);
      if (draft) {
        draft.customerName = name;
        draft.customerLastName = lastName;
        draft.step = 'party_size';
      }
      return draft;
    }
  );

  jest.spyOn(ReservationService, 'setCustomerLastName').mockImplementation(
    async (convId: string, lastName: string) => {
      const draft = drafts.get(convId);
      if (draft) {
        draft.customerLastName = lastName;
        draft.step = 'party_size';
      }
      return draft;
    }
  );

  jest.spyOn(ReservationService, 'setNameOnly').mockImplementation(async (convId: string, name: string) => {
    const draft = drafts.get(convId);
    if (draft) {
      draft.customerName = name;
    }
    return draft;
  });

  jest.spyOn(ReservationService, 'setPartySize').mockImplementation(async (convId: string, size: number) => {
    const draft = drafts.get(convId);
    if (draft) {
      draft.partySize = size;
      draft.step = 'completed';
    }
    return draft;
  });

  jest.spyOn(ReservationService, 'deleteDraft').mockImplementation(async (convId: string) => {
    drafts.set(convId, null);
    return true;
  });

  jest.spyOn(ReservationService, 'saveDraft').mockImplementation(async (draft: any) => {
    drafts.set(draft.conversationId, draft);
    return draft;
  });

  jest.spyOn(ReservationService, 'startEditReservation').mockImplementation(
    async (convId: string, bizId: string, resId: string, data?: any) => {
      const now = Date.now();
      const draft = {
        conversationId: convId,
        businessId: bizId,
        step: 'party_size' as const,
        customerName: data?.customerName,
        partySize: data?.partySize,
        existingReservationId: resId,
        editMode: true,
        createdAt: now,
        updatedAt: now,
        invalidAttempts: 0,
      };
      drafts.set(convId, draft);
      return draft;
    }
  );

  jest.spyOn(ReservationService, 'startEditMenu').mockImplementation(
    async (convId: string, bizId: string, resId: string, data?: any) => {
      const now = Date.now();
      const draft = {
        conversationId: convId,
        businessId: bizId,
        step: 'edit_menu' as const,
        customerName: data?.customerName,
        partySize: data?.partySize,
        existingReservationId: resId,
        editMode: true,
        createdAt: now,
        updatedAt: now,
        invalidAttempts: 0,
      };
      drafts.set(convId, draft);
      return draft;
    }
  );

  // Conversation history (in-memory)
  const histories = new Map<string, any[]>();

  jest.spyOn(agentService, 'getConversationHistory').mockImplementation(async (convId: string) => {
    return histories.get(convId) ?? [];
  });

  jest.spyOn(agentService, 'clearConversationHistory').mockImplementation(async (convId: string) => {
    histories.delete(convId);
  });

  // Wrap generateResponse to track ACTUAL LLM usage.
  // The mock replicates the real agent's deterministic scope guards so that
  // greetings/opt-ins return an intro without counting as an LLM call, while
  // messages that would truly reach the LLM are tracked.
  jest.spyOn(agentService, 'generateResponse').mockImplementation(
    async (_msg, agent, convId, ctx) => {
      if (agent.id === 'waitlist') {
        // Replicate deterministic intro for greetings / opt-in (no LLM call)
        if (!ctx?.currentStep && isGreetingOrReservationOptInMessage(_msg)) {
          const introMessage = buildReservationIntroMessage(ctx?.businessName);
          return {
            response: introMessage,
            action: 'CREATE_RESERVATION',
            conversationId: convId,
            agent: { id: agent.id, name: agent.name },
            processingTime: 10,
          };
        }

        // Replicate deterministic scope guard (no LLM call)
        const scopeResult = evaluateReservationScope(_msg, {
          businessName: ctx?.businessName,
          currentStep: ctx?.currentStep,
        });
        if (scopeResult.decision !== 'allow') {
          return {
            response: scopeResult.message ?? '',
            action: null,
            conversationId: convId,
            agent: { id: agent.id, name: agent.name },
            processingTime: 10,
          };
        }
      }

      // If we reach here, the real agent would call the LLM
      llmCalled.push(true);
      return {
        response: '¿Cuál es tu nombre para continuar con la reserva?',
        action: 'CREATE_RESERVATION',
        conversationId: convId,
        agent: { id: agent.id, name: agent.name },
        processingTime: 100,
      };
    }
  );

  return {
    handler,
    mocks,
    botMessages,
    llmCalled,
    draftSteps,
    reservationsCreated,
  };
}

// ---------------------------------------------------------------------------
// Run a single scenario
// ---------------------------------------------------------------------------

async function runScenario(scenario: ConversationScenario): Promise<void> {
  const ctx = setupMocks(scenario);

  for (let i = 0; i < scenario.turns.length; i++) {
    const turn = scenario.turns[i];
    const msgCountBefore = ctx.botMessages.length;
    const llmCallCountBefore = ctx.llmCalled.length;
    const reservationCountBefore = ctx.reservationsCreated.length;

    // Simulate sending the message (already merged — debounce is tested separately)
    const msg = buildMessage(turn.user, i);
    await (ctx.handler as any)._processMessage(msg);

    const botResponse = ctx.botMessages.slice(msgCountBefore).join('\n');
    const llmCalledThisTurn = ctx.llmCalled.length > llmCallCountBefore;
    const reservationCreatedThisTurn = ctx.reservationsCreated.length > reservationCountBefore;

    const turnLabel = `[${scenario.id}] turn ${i + 1} ("${turn.user.substring(0, 40)}")`;

    // ------ Assertions ------

    if (turn.expect.contains) {
      for (const substr of turn.expect.contains) {
        expect({
          scenario: turnLabel,
          expected: `contains "${substr}"`,
          actual: botResponse,
          pass: botResponse.toLowerCase().includes(substr.toLowerCase()),
        }).toEqual(
          expect.objectContaining({ pass: true })
        );
      }
    }

    if (turn.expect.notContains) {
      for (const substr of turn.expect.notContains) {
        expect({
          scenario: turnLabel,
          unexpected: `should NOT contain "${substr}"`,
          actual: botResponse,
          pass: !botResponse.toLowerCase().includes(substr.toLowerCase()),
        }).toEqual(
          expect.objectContaining({ pass: true })
        );
      }
    }

    if (turn.expect.noLlmCall === true) {
      expect({
        scenario: turnLabel,
        expected: 'no LLM call',
        llmCalled: llmCalledThisTurn,
        pass: !llmCalledThisTurn,
      }).toEqual(
        expect.objectContaining({ pass: true })
      );
    }

    if (turn.expect.reservationCreated === true) {
      expect({
        scenario: turnLabel,
        expected: 'reservation created',
        created: reservationCreatedThisTurn,
        pass: reservationCreatedThisTurn,
      }).toEqual(
        expect.objectContaining({ pass: true })
      );
    }

    if (turn.expect.reservationCreated === false) {
      expect({
        scenario: turnLabel,
        expected: 'reservation NOT created',
        created: reservationCreatedThisTurn,
        pass: !reservationCreatedThisTurn,
      }).toEqual(
        expect.objectContaining({ pass: true })
      );
    }

    if (turn.expect.isOffTopic) {
      expect({
        scenario: turnLabel,
        expected: 'off-topic response',
        actual: botResponse,
        pass: botResponse.toLowerCase().includes('reserva') || botResponse.toLowerCase().includes('solo puedo'),
      }).toEqual(
        expect.objectContaining({ pass: true })
      );
    }

    if (turn.expect.isSpecificTime) {
      expect({
        scenario: turnLabel,
        expected: 'specific-time rejection',
        actual: botResponse,
        pass:
          botResponse.toLowerCase().includes('instantáneas') ||
          botResponse.toLowerCase().includes('turno actual') ||
          botResponse.toLowerCase().includes('hora específica'),
      }).toEqual(
        expect.objectContaining({ pass: true })
      );
    }

    if (turn.expect.isBlocked) {
      expect({
        scenario: turnLabel,
        expected: 'blocked by single-active policy',
        actual: botResponse,
        pass:
          botResponse.toLowerCase().includes('ya tenés una reserva') ||
          botResponse.toLowerCase().includes('tu nueva reserva se superpone') ||
          botResponse.toLowerCase().includes('se superpone con una reserva activa'),
      }).toEqual(
        expect.objectContaining({ pass: true })
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Test suites by category
// ---------------------------------------------------------------------------

const categories: ScenarioCategory[] = [
  'happy_path',
  'off_topic',
  'vulgar_abuse',
  'hallucination_trigger',
  'specific_time',
  'double_message',
  'cancellation',
  'name_correction',
  'prefilled',
  'edit_flow',
  'courtesy',
  'mixed_input',
];

describe('Conversation Scenario Battery', () => {
  // Register the agent before all tests
  beforeAll(() => {
    // Agent registry should already be loaded via the import
    expect(agentRegistry.get('waitlist')).toBeDefined();
  });

  describe.each(categories)('Category: %s', (category) => {
    const scenarios = getScenariosByCategory(category);

    if (scenarios.length === 0) {
      it.skip(`no scenarios for ${category}`, () => { });
      return;
    }

    it.each(scenarios.map(s => [s.id, s.description, s]))(
      '%s — %s',
      async (_id, _desc, scenario) => {
        await runScenario(scenario as ConversationScenario);
      }
    );
  });

  // Summary test: make sure we have a significant number of scenarios
  it('should have at least 50 scenarios total', () => {
    expect(ALL_SCENARIOS.length).toBeGreaterThanOrEqual(50);
  });

  it('should cover all scenario categories', () => {
    const coveredCategories = new Set(ALL_SCENARIOS.map(s => s.category));
    for (const cat of categories) {
      expect(coveredCategories.has(cat)).toBe(true);
    }
  });
});
