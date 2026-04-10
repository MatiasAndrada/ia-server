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

  it('returns the specific-time fallback without calling Ollama', async () => {
    const response = await agentService.generateResponse(
      'Quiero reservar a las 22:30 para 4 personas',
      waitlistAgent,
      undefined,
      { businessName: 'Bodegón Central' }
    );

    expect(response.response).toBe(
      'Hola 😊 Por ahora solo puedo ayudarte con reservas instantáneas para el turno actual en “Bodegón Central”. Todavía no puedo tomar reservas para una hora específica. ¿Querés hacer una reserva?'
    );
    expect(response.action).toBeNull();
    expect(ollamaService.chat).not.toHaveBeenCalled();
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
});