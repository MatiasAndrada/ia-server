jest.mock('../../services/openrouter.service', () => ({
  openRouterService: {
    chatWithActions: jest.fn(),
  },
}));

jest.mock('../../utils/logger');

import { extractReservationUpdate, reservationNluMetrics } from '../../services/reservation-nlu.service';
import { openRouterService } from '../../services/openrouter.service';
import { ReservationDraft } from '../../types';

const chatWithActions = openRouterService.chatWithActions as jest.Mock;

/** Helper: shape a fake OpenRouter tool call the way the real API returns it. */
function toolCallResult(args: Record<string, unknown>) {
  return {
    content: '',
    toolCalls: [
      {
        id: 'call_1',
        type: 'function',
        function: {
          name: 'update_reservation',
          arguments: JSON.stringify(args),
        },
      },
    ],
  };
}

const nameDraft: ReservationDraft = {
  conversationId: 'biz-123',
  businessId: 'biz',
  step: 'name',
  createdAt: Date.now(),
  updatedAt: Date.now(),
};

describe('extractReservationUpdate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    reservationNluMetrics.extracted = 0;
    reservationNluMetrics.empty = 0;
    reservationNluMetrics.error = 0;
  });

  it('extracts a single field from a tool call', async () => {
    chatWithActions.mockResolvedValue(toolCallResult({ customerName: 'Juan' }));

    const result = await extractReservationUpdate('me llamo Juan', nameDraft, 'Bodegón Central');

    expect(result).toEqual({ customerName: 'Juan' });
    expect(reservationNluMetrics.extracted).toBe(1);
  });

  it('extracts several fields mentioned in one message', async () => {
    chatWithActions.mockResolvedValue(
      toolCallResult({
        customerName: 'Juan',
        partySizeText: '4',
        dateText: 'mañana',
        timeText: '21:00',
      })
    );

    const result = await extractReservationUpdate(
      'Soy Juan, somos 4 para mañana a las 21',
      nameDraft,
      'Bodegón Central'
    );

    expect(result).toMatchObject({
      customerName: 'Juan',
      partySizeText: '4',
      dateText: 'mañana',
      timeText: '21:00',
    });
    expect(reservationNluMetrics.extracted).toBe(1);
  });

  it('surfaces offTopic when the model marks the message unrelated', async () => {
    chatWithActions.mockResolvedValue(toolCallResult({ offTopic: true }));

    const result = await extractReservationUpdate('¿cómo está el clima?', nameDraft, 'Bodegón Central');

    expect(result).toEqual({ offTopic: true });
  });

  it('surfaces nameLooksInvalid for offensive/non-name input', async () => {
    chatWithActions.mockResolvedValue(
      toolCallResult({ customerName: 'boludo', nameLooksInvalid: true })
    );

    const result = await extractReservationUpdate('boludo', nameDraft, 'Bodegón Central');

    expect(result?.nameLooksInvalid).toBe(true);
  });

  it('returns null (so the caller falls back to regex) when the model makes no tool call', async () => {
    chatWithActions.mockResolvedValue({ content: 'texto suelto', toolCalls: [] });

    const result = await extractReservationUpdate('???', nameDraft, 'Bodegón Central');

    expect(result).toBeNull();
    expect(reservationNluMetrics.empty).toBe(1);
  });

  it('returns null (fallback) when the LLM call throws', async () => {
    chatWithActions.mockRejectedValue(new Error('network down'));

    const result = await extractReservationUpdate('hola', nameDraft, 'Bodegón Central');

    expect(result).toBeNull();
    expect(reservationNluMetrics.error).toBe(1);
  });

  it('returns null (fallback) when the tool arguments are malformed JSON', async () => {
    chatWithActions.mockResolvedValue({
      content: '',
      toolCalls: [
        {
          id: 'call_1',
          type: 'function',
          function: { name: 'update_reservation', arguments: '{ not json' },
        },
      ],
    });

    const result = await extractReservationUpdate('hola', nameDraft, 'Bodegón Central');

    expect(result).toBeNull();
    expect(reservationNluMetrics.error).toBe(1);
  });
});
