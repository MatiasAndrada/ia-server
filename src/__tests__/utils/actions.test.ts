import { parseActions, calculateConfidence, extractEntities, cleanResponseText } from '../../utils/actions';

describe('Actions Utils', () => {
  describe('parseActions', () => {
    it('should parse explicit action from response', () => {
      const response = 'I will register you. [ACTION:REGISTER:{"name":"John","partySize":4}]';
      const actions = parseActions(response);

      expect(actions).toHaveLength(1);
      expect(actions[0].type).toBe('REGISTER');
      expect(actions[0].data).toEqual({ name: 'John', partySize: 4 });
      expect(actions[0].confidence).toBe(0.9);
    });

    it('should parse multiple actions', () => {
      const response = 
        'Processing... [ACTION:REGISTER:{"name":"John"}] [ACTION:CHECK_STATUS:{"phone":"+123"}]';
      const actions = parseActions(response);

      expect(actions).toHaveLength(2);
      expect(actions[0].type).toBe('REGISTER');
      expect(actions[1].type).toBe('CHECK_STATUS');
    });

    it('should infer REGISTER action from text', () => {
      const response = 'Claro, te anoto en la lista. ¿Cuántas personas?';
      const actions = parseActions(response);

      expect(actions).toHaveLength(1);
      expect(actions[0].type).toBe('REGISTER');
      expect(actions[0].data.inferred).toBe(true);
    });

    it('should infer CHECK_STATUS action', () => {
      const response = 'Tu posición en la lista es la siguiente...';
      const actions = parseActions(response);

      expect(actions).toHaveLength(1);
      expect(actions[0].type).toBe('CHECK_STATUS');
    });

    it('should return empty array for unclear text', () => {
      const response = 'Hola, ¿cómo estás?';
      const actions = parseActions(response);

      expect(actions).toHaveLength(0);
    });
  });

  describe('calculateConfidence', () => {
    it('should return high confidence for explicit actions', () => {
      const response = 'Response with action';
      const actions = [{ type: 'REGISTER' as const, data: {}, confidence: 0.9 }];
      
      const confidence = calculateConfidence(response, actions);
      expect(confidence).toBeGreaterThanOrEqual(0.9);
    });

    it('should return lower confidence for inferred actions', () => {
      const response = 'Response text';
      const actions = [{ type: 'REGISTER' as const, data: { inferred: true }, confidence: 0.6 }];
      
      const confidence = calculateConfidence(response, actions);
      expect(confidence).toBeLessThan(0.9);
    });

    it('should adjust confidence based on professional markers', () => {
      const response = 'Con gusto te ayudo, por favor espera';
      const actions: any[] = [];
      
      const confidence = calculateConfidence(response, actions);
      expect(confidence).toBeGreaterThan(0.5);
    });
  });

  describe('extractEntities', () => {
    it('should extract party size', () => {
      const text = 'Somos 4 personas';
      const entities = extractEntities(text);

      expect(entities.partySize).toBe(4);
    });

    it('should extract name', () => {
      const text = 'Me llamo Juan Pérez';
      const entities = extractEntities(text);

      expect(entities.name).toBe('Juan Pérez');
    });

    it('should extract preferences', () => {
      const text = 'Preferimos mesa cerca de la ventana';
      const entities = extractEntities(text);

      expect(entities.preferences).toContain('ventana');
    });

    it('should handle text without entities', () => {
      const text = 'Hola';
      const entities = extractEntities(text);

      expect(Object.keys(entities)).toHaveLength(0);
    });
  });

  describe('cleanResponseText', () => {
    it('should remove action markers', () => {
      const text = 'Response text [ACTION:REGISTER:{"data":"value"}] more text';
      const cleaned = cleanResponseText(text);

      expect(cleaned).toBe('Response text  more text');
      expect(cleaned).not.toContain('[ACTION:');
    });

    it('should handle text without markers', () => {
      const text = 'Clean response text';
      const cleaned = cleanResponseText(text);

      expect(cleaned).toBe('Clean response text');
    });
  });
});
