jest.mock('../../services/ollama.service', () => ({
  ollamaService: {
    chat: jest.fn(),
  },
}));

jest.mock('../../config/redis', () => ({
  RedisConfig: {
    getClient: jest.fn(() => ({
      get: jest.fn(),
      setEx: jest.fn(),
      del: jest.fn(),
    })),
  },
}));

jest.mock('../../utils/logger');

import { agentService } from '../../services/agent.service';
import { ollamaService } from '../../services/ollama.service';
import { waitlistAgent } from '../../agents/waitlist.agent';

describe('AgentService reservation scope guard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns the off-topic fallback without calling Ollama', async () => {
    const response = await agentService.generateResponse(
      '¿Cómo está el clima hoy?',
      waitlistAgent,
      undefined,
      { businessName: 'Bodegón Central' }
    );

    expect(response.response).toBe(
      'Hola 😊 Solo puedo ayudarte con consultas relacionadas a reservas para “Bodegón Central” en el turno actual. ¿Querés hacer una reserva?'
    );
    expect(response.action).toBeNull();
    expect(ollamaService.chat).not.toHaveBeenCalled();
  });

  it('returns the intro message for greetings without calling Ollama', async () => {
    const response = await agentService.generateResponse(
      'Hola',
      waitlistAgent,
      undefined,
      { businessName: 'Bodegón Central' }
    );

    expect(response.response).toBe(
      '¡Hola! 👋 Soy el asistente de Bodegón Central y estoy para generar reservas. ¿Cuál es tu nombre?'
    );
    expect(response.action).toBe('CREATE_RESERVATION');
    expect(ollamaService.chat).not.toHaveBeenCalled();
  });

  it('returns the intro message for affirmative opt-in without calling Ollama', async () => {
    const response = await agentService.generateResponse(
      'Si',
      waitlistAgent,
      undefined,
      { businessName: 'Bodegón Central' }
    );

    expect(response.response).toBe(
      '¡Hola! 👋 Soy el asistente de Bodegón Central y estoy para generar reservas. ¿Cuál es tu nombre?'
    );
    expect(response.action).toBe('CREATE_RESERVATION');
    expect(ollamaService.chat).not.toHaveBeenCalled();
  });

  it('no longer hard-blocks specific-time messages — they are reservation-related and reach the agent', async () => {
    (ollamaService.chat as jest.Mock).mockResolvedValue('¿Para cuántas personas es la reserva?');

    const response = await agentService.generateResponse(
      'Quiero reservar a las 22:30 para 4 personas',
      waitlistAgent,
      undefined,
      { businessName: 'Bodegón Central' }
    );

    // Since scheduled reservations are now supported, a specific-time mention no
    // longer trips the scope guard — it's classified as reservation-related and
    // passed through to the agent instead of being rejected outright.
    expect(ollamaService.chat).toHaveBeenCalledTimes(1);
    expect(response.response).toBe('¿Para cuántas personas es la reserva?');
  });

  it('handles "Quiero reservar" as deterministic opt-in without calling Ollama', async () => {
    const response = await agentService.generateResponse(
      'Quiero reservar',
      waitlistAgent,
      undefined,
      { businessName: 'Bodegón Central' }
    );

    // "Quiero reservar" is now caught by the reservation opt-in scope guard
    // and returns a deterministic intro without reaching Ollama
    expect(ollamaService.chat).not.toHaveBeenCalled();
    expect(response.response).toContain('nombre');
    expect(response.action).toBe('CREATE_RESERVATION');
  });

  it('handles the bare "RESERVAR" keyword as deterministic opt-in without calling Ollama', async () => {
    // This is the exact keyword the bot tells customers to send to start a
    // new reservation (see message-templates.ts's "escribí: RESERVAR").
    // Before this fix it fell through every fast path into the agent/Ollama,
    // causing high load and slow replies for the most common re-engagement message.
    const response = await agentService.generateResponse(
      'RESERVAR',
      waitlistAgent,
      undefined,
      { businessName: 'Bodegón Central' }
    );

    expect(ollamaService.chat).not.toHaveBeenCalled();
    expect(response.response).toContain('nombre');
    expect(response.action).toBe('CREATE_RESERVATION');
  });
});