import {
  buildActionTool,
  parseToolCallActions,
  calculateConfidence,
  extractEntities,
  cleanResponseText,
} from '../../utils/actions';

describe('Actions Utils', () => {
  describe('buildActionTool', () => {
    it('should expose emit_action with the four known action types in its schema', () => {
      const tool = buildActionTool();

      expect(tool.type).toBe('function');
      expect(tool.function.name).toBe('emit_action');
      expect(tool.function.parameters.properties.type.enum).toEqual([
        'REGISTER',
        'CHECK_STATUS',
        'CANCEL',
        'INFO_REQUEST',
      ]);
    });
  });

  describe('parseToolCallActions', () => {
    it('should parse a single tool call into an Action', () => {
      const toolCalls = [
        {
          id: 'call_1',
          type: 'function' as const,
          function: { name: 'emit_action', arguments: '{"type":"REGISTER","name":"John","partySize":4}' },
        },
      ];

      const actions = parseToolCallActions(toolCalls);

      expect(actions).toHaveLength(1);
      expect(actions[0].type).toBe('REGISTER');
      expect(actions[0].data).toEqual({ name: 'John', partySize: 4 });
      expect(actions[0].confidence).toBe(0.9);
    });

    it('should parse multiple tool calls', () => {
      const toolCalls = [
        {
          id: 'call_1',
          type: 'function' as const,
          function: { name: 'emit_action', arguments: '{"type":"REGISTER","name":"John"}' },
        },
        {
          id: 'call_2',
          type: 'function' as const,
          function: { name: 'emit_action', arguments: '{"type":"CHECK_STATUS"}' },
        },
      ];

      const actions = parseToolCallActions(toolCalls);

      expect(actions).toHaveLength(2);
      expect(actions[0].type).toBe('REGISTER');
      expect(actions[1].type).toBe('CHECK_STATUS');
    });

    it('should skip tool calls with an unknown action type', () => {
      const toolCalls = [
        {
          id: 'call_1',
          type: 'function' as const,
          function: { name: 'emit_action', arguments: '{"type":"NOT_A_REAL_ACTION"}' },
        },
      ];

      expect(parseToolCallActions(toolCalls)).toHaveLength(0);
    });

    it('should skip tool calls with malformed JSON arguments instead of throwing', () => {
      const toolCalls = [
        {
          id: 'call_1',
          type: 'function' as const,
          function: { name: 'emit_action', arguments: '{not valid json' },
        },
      ];

      expect(parseToolCallActions(toolCalls)).toHaveLength(0);
    });

    it('should return empty array when there are no tool calls', () => {
      expect(parseToolCallActions([])).toHaveLength(0);
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
