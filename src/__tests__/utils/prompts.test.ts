import { buildSystemPrompt, buildIntentPrompt, buildFallbackResponse } from '../../utils/prompts';
import { BusinessContext } from '../../types';

describe('Prompts Utils', () => {
  describe('buildSystemPrompt', () => {
    it('should build prompt with business context', () => {
      const context: BusinessContext = {
        businessName: 'Restaurante La Plaza',
        businessAddress: 'Av. Corrientes 1234',
        businessHours: '12:00 - 23:00',
        currentWaitlist: 5,
        averageWaitTime: 20,
        customerInfo: {
          isKnown: true,
          name: 'Juan',
          previousVisits: 3,
        },
      };

      const prompt = buildSystemPrompt(context);

      expect(prompt).toContain('Restaurante La Plaza');
      expect(prompt).toContain('Av. Corrientes 1234');
      expect(prompt).toContain('12:00 - 23:00');
      expect(prompt).toContain('5 personas');
      expect(prompt).toContain('20 minutos');
      expect(prompt).toContain('Juan');
      expect(prompt).toContain('3 visitas previas');
    });

    it('should build prompt without context', () => {
      const prompt = buildSystemPrompt();

      expect(prompt).toContain('restaurante');
      expect(prompt).toContain('lista de espera');
      expect(prompt).toContain('WhatsApp');
    });

    it('should handle unknown customer', () => {
      const context: BusinessContext = {
        businessName: 'Test Restaurant',
        currentWaitlist: 0,
        averageWaitTime: 15,
        customerInfo: {
          isKnown: false,
        },
      };

      const prompt = buildSystemPrompt(context);

      expect(prompt).toContain('cliente nuevo');
    });

    it('should include action format instructions', () => {
      const prompt = buildSystemPrompt();

      expect(prompt).toContain('[ACTION:');
      expect(prompt).toContain('REGISTER');
      expect(prompt).toContain('CHECK_STATUS');
      expect(prompt).toContain('CONFIRM_ARRIVAL');
      expect(prompt).toContain('CANCEL');
    });
  });

  describe('buildIntentPrompt', () => {
    it('should include all possible intents', () => {
      const prompt = buildIntentPrompt();

      expect(prompt).toContain('register');
      expect(prompt).toContain('query_status');
      expect(prompt).toContain('confirm_arrival');
      expect(prompt).toContain('cancel');
      expect(prompt).toContain('request_info');
      expect(prompt).toContain('general_question');
      expect(prompt).toContain('greeting');
      expect(prompt).toContain('unknown');
    });

    it('should specify JSON response format', () => {
      const prompt = buildIntentPrompt();

      expect(prompt).toContain('JSON');
      expect(prompt).toContain('intent');
      expect(prompt).toContain('entities');
      expect(prompt).toContain('confidence');
    });

    it('should list entities to extract', () => {
      const prompt = buildIntentPrompt();

      expect(prompt).toContain('name');
      expect(prompt).toContain('partySize');
      expect(prompt).toContain('preferences');
    });
  });

  describe('buildFallbackResponse', () => {
    it('should return fallback message with business name', () => {
      const context: BusinessContext = {
        businessName: 'Mi Restaurante',
        currentWaitlist: 0,
        averageWaitTime: 15,
      };

      const response = buildFallbackResponse(context);

      expect(response).toContain('Mi Restaurante');
      expect(response).toContain('problemas técnicos');
    });

    it('should return generic fallback without context', () => {
      const response = buildFallbackResponse();

      expect(response).toContain('problemas técnicos');
      expect(response).toContain('restaurante');
    });
  });
});
