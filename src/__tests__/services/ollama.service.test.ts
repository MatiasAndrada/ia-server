import axios from 'axios';
import { OllamaService } from '../../services/ollama.service';
import { OllamaConfig } from '../../config/ollama';
import { EnvConfig } from '../../types';

// Mock axios and OllamaConfig
jest.mock('axios');
jest.mock('../../config/ollama');
jest.mock('../../utils/logger');

const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('OllamaService', () => {
  let service: OllamaService;
  let mockAxiosInstance: any;

  beforeEach(() => {
    // Reset mocks
    jest.clearAllMocks();

    // Create mock axios instance
    mockAxiosInstance = {
      post: jest.fn(),
      get: jest.fn(),
    };

    // Mock OllamaConfig
    (OllamaConfig.getClient as jest.Mock).mockReturnValue(mockAxiosInstance);
    (OllamaConfig.getModel as jest.Mock).mockReturnValue('llama3.2');
    (OllamaConfig.healthCheck as jest.Mock).mockResolvedValue(true);

    service = new OllamaService();
  });

  describe('chat', () => {
    it('should successfully get AI response', async () => {
      const mockResponse = {
        data: {
          message: {
            role: 'assistant',
            content: 'Hello! How can I help you?',
          },
          done: true,
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
          message: { role: 'assistant', content: 'Response' },
          done: true,
        },
      };

      mockAxiosInstance.post.mockResolvedValue(mockResponse);

      await service.chat(
        [{ role: 'user', content: 'Test' }],
        'System prompt'
      );

      const callArgs = mockAxiosInstance.post.mock.calls[0][1];
      expect(callArgs.messages).toHaveLength(2);
      expect(callArgs.messages[0].role).toBe('system');
      expect(callArgs.messages[0].content).toBe('System prompt');
    });

    it('should retry on failure', async () => {
      const mockError = new Error('Connection failed');
      const mockSuccess = {
        data: {
          message: { role: 'assistant', content: 'Success after retry' },
          done: true,
        },
      };

      mockAxiosInstance.post
        .mockRejectedValueOnce(mockError)
        .mockResolvedValueOnce(mockSuccess);

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

  describe('healthCheck', () => {
    it('should return healthy status when Ollama is available', async () => {
      (OllamaConfig.healthCheck as jest.Mock).mockResolvedValue(true);
      mockAxiosInstance.post.mockResolvedValue({
        data: {
          message: { role: 'assistant', content: 'Hi' },
          done: true,
        },
      });

      const result = await service.healthCheck();

      expect(result.available).toBe(true);
      expect(result.model).toBe('llama3.2');
      expect(result.error).toBeUndefined();
    });

    it('should return unhealthy when Ollama is not responding', async () => {
      (OllamaConfig.healthCheck as jest.Mock).mockResolvedValue(false);

      const result = await service.healthCheck();

      expect(result.available).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should handle health check errors', async () => {
      (OllamaConfig.healthCheck as jest.Mock).mockRejectedValue(
        new Error('Connection refused')
      );

      const result = await service.healthCheck();

      expect(result.available).toBe(false);
      expect(result.error).toContain('Connection refused');
    });
  });
});
