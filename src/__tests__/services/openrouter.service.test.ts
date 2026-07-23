import { OpenRouterService } from '../../services/openrouter.service';
import { OpenRouterConfig } from '../../config/openrouter';

// Mock OpenRouterConfig
jest.mock('../../config/openrouter');
jest.mock('../../utils/logger');

describe('OpenRouterService', () => {
  let service: OpenRouterService;
  let mockAxiosInstance: any;

  beforeEach(() => {
    // Reset mocks
    jest.clearAllMocks();

    // Create mock axios instance
    mockAxiosInstance = {
      post: jest.fn(),
      get: jest.fn(),
    };

    // Mock OpenRouterConfig
    (OpenRouterConfig.getClient as jest.Mock).mockReturnValue(mockAxiosInstance);
    (OpenRouterConfig.getModel as jest.Mock).mockReturnValue('anthropic/claude-3.5-sonnet');
    (OpenRouterConfig.getFallbackModels as jest.Mock).mockReturnValue([]);
    (OpenRouterConfig.healthCheck as jest.Mock).mockResolvedValue(true);

    service = new OpenRouterService();
  });

  describe('chat', () => {
    it('should successfully get AI response', async () => {
      const mockResponse = {
        data: {
          choices: [{ message: { role: 'assistant', content: 'Hello! How can I help you?' } }],
        },
      };

      mockAxiosInstance.post.mockResolvedValue(mockResponse);

      const result = await service.chat(
        [{ role: 'user', content: 'Hello' }],
        'You are a helpful assistant'
      );

      expect(result).toBe('Hello! How can I help you?');
      expect(mockAxiosInstance.post).toHaveBeenCalledTimes(1);
    });

    it('should include system prompt in messages', async () => {
      const mockResponse = {
        data: {
          choices: [{ message: { role: 'assistant', content: 'Response' } }],
        },
      };

      mockAxiosInstance.post.mockResolvedValue(mockResponse);

      await service.chat([{ role: 'user', content: 'Test' }], 'System prompt');

      const callArgs = mockAxiosInstance.post.mock.calls[0][1];
      expect(callArgs.messages).toHaveLength(2);
      expect(callArgs.messages[0].role).toBe('system');
      expect(callArgs.messages[0].content).toBe('System prompt');
    });

    it('should request fallback models alongside the primary model when configured', async () => {
      (OpenRouterConfig.getFallbackModels as jest.Mock).mockReturnValue(['openai/gpt-4o-mini']);
      mockAxiosInstance.post.mockResolvedValue({
        data: { choices: [{ message: { role: 'assistant', content: 'ok' } }] },
      });

      await service.chat([{ role: 'user', content: 'Test' }]);

      const callArgs = mockAxiosInstance.post.mock.calls[0][1];
      expect(callArgs.models).toEqual(['anthropic/claude-3.5-sonnet', 'openai/gpt-4o-mini']);
    });

    it('should retry on failure', async () => {
      const mockError = new Error('Connection failed');
      const mockSuccess = {
        data: {
          choices: [{ message: { role: 'assistant', content: 'Success after retry' } }],
        },
      };

      mockAxiosInstance.post.mockRejectedValueOnce(mockError).mockResolvedValueOnce(mockSuccess);

      const result = await service.chat([{ role: 'user', content: 'Test' }]);

      expect(result).toBe('Success after retry');
      expect(mockAxiosInstance.post).toHaveBeenCalledTimes(2);
    });

    it('should return fallback after max retries', async () => {
      const mockError = new Error('Connection failed');
      mockAxiosInstance.post.mockRejectedValue(mockError);

      const result = await service.chat([{ role: 'user', content: 'Test' }]);

      expect(result).toContain('problemas técnicos');
      expect(mockAxiosInstance.post).toHaveBeenCalledTimes(2); // Initial + 1 retry
    });

    it('should handle invalid response format', async () => {
      mockAxiosInstance.post.mockResolvedValue({
        data: { invalid: 'format' },
      });

      const result = await service.chat([{ role: 'user', content: 'Test' }]);

      expect(result).toContain('problemas técnicos');
    });
  });

  describe('chatWithActions', () => {
    it('should return tool calls emitted by the model', async () => {
      const toolCalls = [
        {
          id: 'call_1',
          type: 'function',
          function: { name: 'emit_action', arguments: '{"type":"REGISTER","partySize":4}' },
        },
      ];

      mockAxiosInstance.post.mockResolvedValue({
        data: {
          choices: [
            {
              message: { role: 'assistant', content: 'Te anoto para 4 personas.', tool_calls: toolCalls },
            },
          ],
        },
      });

      const result = await service.chatWithActions(
        [{ role: 'user', content: 'Quiero anotarme para 4' }],
        'system',
        [{ type: 'function', function: { name: 'emit_action', description: 'x', parameters: {} } }]
      );

      expect(result.content).toBe('Te anoto para 4 personas.');
      expect(result.toolCalls).toEqual(toolCalls);

      const callArgs = mockAxiosInstance.post.mock.calls[0][1];
      expect(callArgs.tools).toHaveLength(1);
      expect(callArgs.tool_choice).toBe('auto');
    });

    it('should return an empty tool call list and no throw after max retries', async () => {
      mockAxiosInstance.post.mockRejectedValue(new Error('down'));

      const result = await service.chatWithActions([{ role: 'user', content: 'Test' }]);

      expect(result.toolCalls).toEqual([]);
      expect(result.content).toContain('problemas técnicos');
    });
  });

  describe('generateBlockedDateReasonMessage', () => {
    it('should return the AI-generated professional message', async () => {
      mockAxiosInstance.post.mockResolvedValue({
        data: {
          choices: [
            {
              message: {
                role: 'assistant',
                content: 'Lamentamos informar que el local permanecerá cerrado por duelo familiar.',
              },
            },
          ],
        },
      });

      const result = await service.generateBlockedDateReasonMessage('duelo');

      expect(result).toBe('Lamentamos informar que el local permanecerá cerrado por duelo familiar.');
      expect(mockAxiosInstance.post).toHaveBeenCalledTimes(1);

      const callArgs = mockAxiosInstance.post.mock.calls[0][1];
      expect(callArgs.messages[1].content).toContain('duelo');
    });

    it('should strip wrapping quotes from the AI response', async () => {
      mockAxiosInstance.post.mockResolvedValue({
        data: {
          choices: [
            { message: { role: 'assistant', content: '"El local estará cerrado por vacaciones."' } },
          ],
        },
      });

      const result = await service.generateBlockedDateReasonMessage('vacaciones');

      expect(result).toBe('El local estará cerrado por vacaciones.');
    });

    it('should fall back to a generic honest message when OpenRouter fails', async () => {
      mockAxiosInstance.post.mockRejectedValue(new Error('Connection failed'));

      const result = await service.generateBlockedDateReasonMessage('mudanza');

      expect(result).toContain('mudanza');
      expect(result).not.toContain('problemas técnicos');
    });
  });

  describe('healthCheck', () => {
    it('should return healthy status when OpenRouter is available', async () => {
      (OpenRouterConfig.healthCheck as jest.Mock).mockResolvedValue(true);

      const result = await service.healthCheck();

      expect(result.available).toBe(true);
      expect(result.model).toBe('anthropic/claude-3.5-sonnet');
      expect(result.error).toBeUndefined();
    });

    it('should return unhealthy when OpenRouter is not responding', async () => {
      (OpenRouterConfig.healthCheck as jest.Mock).mockResolvedValue(false);

      const result = await service.healthCheck();

      expect(result.available).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should handle health check errors', async () => {
      (OpenRouterConfig.healthCheck as jest.Mock).mockRejectedValue(new Error('Connection refused'));

      const result = await service.healthCheck();

      expect(result.available).toBe(false);
      expect(result.error).toContain('Connection refused');
    });
  });
});
