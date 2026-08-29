import { OpenRouterService } from '../../services/openrouter.service.js';
import { LlmMessage, LlmToolCall, LlmToolDefinition } from '../../types/index.js';

jest.mock('../../utils/logger');

/**
 * Tests del loop de tool-calling.
 *
 * Se mockea `chatWithActions` (la capa HTTP ya tiene sus propios tests) para
 * scriptear exactamente qué devuelve el modelo en cada iteración. Lo que se
 * verifica es el CONTRATO del historial, que es donde OpenRouter es estricto:
 * un mensaje `tool` cuyo `tool_call_id` no aparezca en el assistant inmediato
 * anterior hace fallar todo el turno.
 */

const TOOL_DEF: LlmToolDefinition = {
  type: 'function',
  function: { name: 'check_availability', description: 'test', parameters: {} },
};

function toolCall(id: string, name: string, args: object = {}): LlmToolCall {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

describe('OpenRouterService.runToolLoop', () => {
  let service: OpenRouterService;
  let chatSpy: jest.SpyInstance;

  beforeEach(() => {
    service = new OpenRouterService();
    chatSpy = jest.spyOn(service, 'chatWithActions');
  });

  afterEach(() => jest.restoreAllMocks());

  it('devuelve la respuesta directa cuando el modelo no pide herramientas', async () => {
    chatSpy.mockResolvedValueOnce({
      content: '¡Hola Matías! ¿Para cuántas personas?',
      toolCalls: [],
      model: 'google/gemini-3.7-flash',
    });

    const result = await service.runToolLoop(
      [{ role: 'user', content: 'hola' }],
      'system',
      [TOOL_DEF],
      async () => ({ ok: true })
    );

    expect(result.content).toContain('Matías');
    expect(result.iterations).toBe(1);
    expect(result.executedToolCalls).toHaveLength(0);
    expect(result.exhausted).toBe(false);
  });

  it('cierra el ciclo: ejecuta la herramienta y devuelve el resultado al modelo', async () => {
    chatSpy
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [toolCall('call_1', 'check_availability', { dateKey: '2026-08-30' })],
        model: 'm',
      })
      .mockResolvedValueOnce({ content: 'Hay lugar a las 21.', toolCalls: [], model: 'm' });

    const executor = jest.fn().mockResolvedValue({ ok: true, data: { available: true } });

    const result = await service.runToolLoop(
      [{ role: 'user', content: '¿hay lugar el domingo?' }],
      'system',
      [TOOL_DEF],
      executor
    );

    expect(executor).toHaveBeenCalledTimes(1);
    expect(result.content).toBe('Hay lugar a las 21.');
    expect(result.iterations).toBe(2);

    // El segundo request tiene que llevar assistant(tool_calls) + tool(result).
    const secondCallMessages = chatSpy.mock.calls[1][0] as LlmMessage[];
    const assistantMsg = secondCallMessages.find((m) => m.role === 'assistant');
    const toolMsg = secondCallMessages.find((m) => m.role === 'tool');

    expect(assistantMsg).toMatchObject({ tool_calls: [expect.objectContaining({ id: 'call_1' })] });
    expect(toolMsg).toMatchObject({ role: 'tool', tool_call_id: 'call_1', name: 'check_availability' });
    expect(JSON.parse((toolMsg as any).content)).toEqual({ ok: true, data: { available: true } });
  });

  it('reenvía las definiciones de tools en CADA request, no sólo en el primero', async () => {
    chatSpy
      .mockResolvedValueOnce({ content: '', toolCalls: [toolCall('c1', 'check_availability')], model: 'm' })
      .mockResolvedValueOnce({ content: 'listo', toolCalls: [], model: 'm' });

    await service.runToolLoop([{ role: 'user', content: 'x' }], 'system', [TOOL_DEF], async () => ({}));

    // OpenRouter rechaza un historial con mensajes `tool` si el request no
    // trae `tools` — por eso esto es una aserción y no un detalle.
    expect(chatSpy).toHaveBeenCalledTimes(2);
    expect(chatSpy.mock.calls[0][2]).toEqual([TOOL_DEF]);
    expect(chatSpy.mock.calls[1][2]).toEqual([TOOL_DEF]);
  });

  it('ejecuta en paralelo las llamadas de un mismo batch y devuelve todos los resultados', async () => {
    chatSpy
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [toolCall('c1', 'check_availability'), toolCall('c2', 'check_availability')],
        model: 'm',
      })
      .mockResolvedValueOnce({ content: 'ok', toolCalls: [], model: 'm' });

    const executor = jest.fn().mockResolvedValue({ ok: true });

    const result = await service.runToolLoop(
      [{ role: 'user', content: 'cancelá una y creá otra' }],
      'system',
      [TOOL_DEF],
      executor
    );

    expect(executor).toHaveBeenCalledTimes(2);
    expect(result.executedToolCalls).toHaveLength(2);

    const toolMessages = (chatSpy.mock.calls[1][0] as LlmMessage[]).filter((m) => m.role === 'tool');
    expect(toolMessages.map((m) => (m as any).tool_call_id)).toEqual(['c1', 'c2']);
  });

  it('corta al agotar el tope de iteraciones y fuerza una respuesta final', async () => {
    // El modelo pide herramientas indefinidamente.
    chatSpy.mockResolvedValue({
      content: '',
      toolCalls: [toolCall('loop', 'check_availability')],
      model: 'm',
    });
    // La llamada de cierre sí responde con texto.
    chatSpy.mockResolvedValueOnce({ content: '', toolCalls: [toolCall('l1', 'check_availability')], model: 'm' });

    const result = await service.runToolLoop(
      [{ role: 'user', content: 'x' }],
      'system',
      [TOOL_DEF],
      async () => ({}),
      { maxIterations: 2 }
    );

    expect(result.exhausted).toBe(true);
    expect(result.iterations).toBe(2);
    // 2 del loop + 1 de cierre forzado: el cliente nunca queda sin respuesta.
    expect(chatSpy).toHaveBeenCalledTimes(3);
  });

  it('propaga sessionId para el sticky routing de OpenRouter', async () => {
    chatSpy.mockResolvedValueOnce({ content: 'ok', toolCalls: [], model: 'm' });

    await service.runToolLoop([{ role: 'user', content: 'x' }], 'system', [TOOL_DEF], async () => ({}), {
      sessionId: 'biz-123-5491155551234',
    });

    expect(chatSpy.mock.calls[0][3]).toMatchObject({ sessionId: 'biz-123-5491155551234' });
  });

  it('serializa un resultado no serializable sin romper el turno', async () => {
    chatSpy
      .mockResolvedValueOnce({ content: '', toolCalls: [toolCall('c1', 'check_availability')], model: 'm' })
      .mockResolvedValueOnce({ content: 'ok', toolCalls: [], model: 'm' });

    const circular: any = { name: 'loop' };
    circular.self = circular;

    await expect(
      service.runToolLoop([{ role: 'user', content: 'x' }], 'system', [TOOL_DEF], async () => circular)
    ).resolves.toMatchObject({ content: 'ok' });

    const toolMsg = (chatSpy.mock.calls[1][0] as LlmMessage[]).find((m) => m.role === 'tool');
    expect(JSON.parse((toolMsg as any).content)).toMatchObject({
      ok: false,
      error: { code: 'unserializable_result' },
    });
  });
});
