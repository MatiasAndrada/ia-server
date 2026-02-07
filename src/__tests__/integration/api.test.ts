import request from 'supertest';
import express, { Express } from 'express';
import { chatHandler, analyzeIntentHandler } from '../../controllers/chat.controller';
import { healthHandler } from '../../controllers/health.controller';
import { validate, chatSchema } from '../../middleware/validation.middleware';

// Mock services
jest.mock('../../services/ollama.service');
jest.mock('../../services/conversation.service');
jest.mock('../../services/intent.service');
jest.mock('../../config/redis');
jest.mock('../../config/ollama');
jest.mock('../../utils/logger');

import { ollamaService } from '../../services/ollama.service';
import { conversationService } from '../../services/conversation.service';
import { intentService } from '../../services/intent.service';
import { RedisConfig } from '../../config/redis';
import { OllamaConfig } from '../../config/ollama';

describe('API Integration Tests', () => {
  let app: Express;

  beforeEach(() => {
    app = express();
    app.use(express.json());

    // Setup routes
    app.post('/api/chat', validate(chatSchema), chatHandler);
    app.post('/api/analyze-intent', analyzeIntentHandler);
    app.get('/health', healthHandler);

    // Reset mocks
    jest.clearAllMocks();

    // Default mock implementations
    (conversationService.getHistory as jest.Mock).mockResolvedValue([]);
    (conversationService.addMessage as jest.Mock).mockResolvedValue(undefined);
    (OllamaConfig.getModel as jest.Mock).mockReturnValue('llama3.2');
  });

  describe('POST /api/chat', () => {
    it('should process chat request successfully', async () => {
      (ollamaService.chat as jest.Mock).mockResolvedValue(
        'Hola! Te puedo ayudar. [ACTION:REGISTER:{"status":"ready"}]'
      );

      const response = await request(app)
        .post('/api/chat')
        .send({
          phone: '+5491112345678',
          message: 'Hola, quiero anotarme',
          businessId: '123e4567-e89b-12d3-a456-426614174000',
          context: {
            businessName: 'Test Restaurant',
            currentWaitlist: 5,
            averageWaitTime: 20,
          },
        });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('response');
      expect(response.body).toHaveProperty('actions');
      expect(response.body).toHaveProperty('confidence');
      expect(response.body.actions).toHaveLength(1);
      expect(response.body.actions[0].type).toBe('REGISTER');
    });

    it('should validate phone number format', async () => {
      const response = await request(app)
        .post('/api/chat')
        .send({
          phone: 'invalid-phone',
          message: 'Test',
          businessId: '123e4567-e89b-12d3-a456-426614174000',
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Validation Error');
    });

    it('should validate business ID format', async () => {
      const response = await request(app)
        .post('/api/chat')
        .send({
          phone: '+5491112345678',
          message: 'Test',
          businessId: 'not-a-uuid',
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Validation Error');
    });

    it('should require message field', async () => {
      const response = await request(app)
        .post('/api/chat')
        .send({
          phone: '+5491112345678',
          businessId: '123e4567-e89b-12d3-a456-426614174000',
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Validation Error');
    });

    it('should handle service errors gracefully', async () => {
      (ollamaService.chat as jest.Mock).mockRejectedValue(
        new Error('Service error')
      );

      const response = await request(app)
        .post('/api/chat')
        .send({
          phone: '+5491112345678',
          message: 'Test',
          businessId: '123e4567-e89b-12d3-a456-426614174000',
        });

      expect(response.status).toBe(500);
      expect(response.body.error).toBe('Internal Server Error');
    });
  });

  describe('POST /api/analyze-intent', () => {
    it('should analyze intent successfully', async () => {
      (intentService.analyzeIntent as jest.Mock).mockResolvedValue({
        intent: 'register',
        entities: { partySize: 4 },
        confidence: 0.9,
      });

      const response = await request(app)
        .post('/api/analyze-intent')
        .send({
          message: 'Quiero anotarme para 4 personas',
        });

      expect(response.status).toBe(200);
      expect(response.body.intent).toBe('register');
      expect(response.body.entities.partySize).toBe(4);
      expect(response.body.confidence).toBe(0.9);
    });

    it('should handle analysis errors', async () => {
      (intentService.analyzeIntent as jest.Mock).mockRejectedValue(
        new Error('Analysis failed')
      );

      const response = await request(app)
        .post('/api/analyze-intent')
        .send({
          message: 'Test message',
        });

      expect(response.status).toBe(500);
    });
  });

  describe('GET /health', () => {
    it('should return healthy status', async () => {
      (ollamaService.healthCheck as jest.Mock).mockResolvedValue({
        available: true,
        model: 'llama3.2',
      });
      (RedisConfig.healthCheck as jest.Mock).mockResolvedValue(true);

      const response = await request(app).get('/health');

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('healthy');
      expect(response.body.ollama).toBe(true);
      expect(response.body.redis).toBe(true);
      expect(response.body.model).toBe('llama3.2');
      expect(response.body).toHaveProperty('uptime');
    });

    it('should return degraded status when Redis is down', async () => {
      (ollamaService.healthCheck as jest.Mock).mockResolvedValue({
        available: true,
        model: 'llama3.2',
      });
      (RedisConfig.healthCheck as jest.Mock).mockResolvedValue(false);

      const response = await request(app).get('/health');

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('degraded');
      expect(response.body.redis).toBe(false);
    });

    it('should return unhealthy when both services are down', async () => {
      (ollamaService.healthCheck as jest.Mock).mockResolvedValue({
        available: false,
        model: 'llama3.2',
      });
      (RedisConfig.healthCheck as jest.Mock).mockResolvedValue(false);

      const response = await request(app).get('/health');

      expect(response.status).toBe(503);
      expect(response.body.status).toBe('unhealthy');
    });
  });
});
