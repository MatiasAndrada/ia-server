import { Writable } from 'node:stream';
import { AxiosError } from 'axios';
import winston from 'winston';
import { logger, logEvent } from '../../utils/logger.js';
import { withLogContext, currentLogContext } from '../../utils/log-context.js';
import { throttle, resetThrottle } from '../../utils/log-throttle.js';

/**
 * Captura la salida real del logger: un transport de stream con el mismo
 * `json()` que usa producción, así lo que se afirma acá es exactamente el texto
 * que termina en `logs/pm2-out.log`, no un objeto intermedio.
 */
function createCapture() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });

  const transport = new winston.transports.Stream({
    stream,
    format: winston.format.json(),
  });

  return {
    transport,
    entries: () => lines.map((l) => JSON.parse(l)),
  };
}

describe('logger', () => {
  let capture: ReturnType<typeof createCapture>;
  const originalLevel = logger.level;

  beforeEach(() => {
    capture = createCapture();
    logger.add(capture.transport);
    logger.level = 'debug';
  });

  afterEach(() => {
    logger.remove(capture.transport);
    logger.level = originalLevel;
  });

  const lastEntry = () => {
    const all = capture.entries();
    return all[all.length - 1];
  };

  describe('normalización de errores', () => {
    it('no filtra el Authorization header de un error de Axios', () => {
      // Este es el caso real que motivó el format: `logger.error('...', { error })`
      // con un error de Axios sin desenvolver serializaba config.headers y con
      // ello la OPENROUTER_API_KEY en texto plano.
      const axiosError = new AxiosError('Request failed with status code 401');
      (axiosError as any).config = {
        headers: { Authorization: 'Bearer sk-or-v1-SECRETO' },
        url: 'https://openrouter.ai/api/v1/chat/completions',
      };
      (axiosError as any).response = { status: 401, data: { error: 'invalid key' } };

      logger.error('OpenRouter call failed', { error: axiosError });

      const serialized = JSON.stringify(lastEntry());
      expect(serialized).not.toContain('sk-or-v1-SECRETO');
      expect(serialized).not.toContain('Bearer');
      expect(lastEntry().error).toMatchObject({
        message: 'Request failed with status code 401',
        httpStatus: 401,
      });
    });

    it('conserva message, code y stack de un Error común', () => {
      const error = Object.assign(new Error('boom'), { code: 'ECONNREFUSED' });

      logger.error('Something broke', { error });

      expect(lastEntry().error).toMatchObject({ message: 'boom', code: 'ECONNREFUSED' });
      expect(lastEntry().error.stack).toContain('boom');
    });

    it('normaliza un PostgrestError, que no es instancia de Error', () => {
      logger.warn('Supabase said no', {
        error: { message: 'row not found', code: 'PGRST116', details: null, hint: null },
      });

      expect(lastEntry().error).toMatchObject({ message: 'row not found', code: 'PGRST116' });
    });
  });

  describe('redacción y límites de tamaño', () => {
    it('redacta claves sensibles en cualquier nivel de anidamiento', () => {
      logger.info('config', { outer: { apiKey: 'abc123', nested: { password: 'hunter2' } } });

      expect(lastEntry().outer.apiKey).toBe('[REDACTED]');
      expect(lastEntry().outer.nested.password).toBe('[REDACTED]');
    });

    it('trunca strings largos para que no entre un payload entero', () => {
      logger.debug('payload', { body: 'x'.repeat(5000) });

      const body: string = lastEntry().body;
      expect(body.length).toBeLessThan(600);
      expect(body).toContain('[+4500 chars]');
    });

    it('acota arrays largos', () => {
      logger.debug('rows', { rows: Array.from({ length: 100 }, (_, i) => i) });

      expect(lastEntry().rows).toHaveLength(21);
      expect(lastEntry().rows[20]).toBe('…[+80 items]');
    });

    it('deja pasar los datos de negocio sin tocar', () => {
      // Decisión explícita del proyecto: teléfonos, nombres y contenido de
      // mensajes se loguean completos. Sólo se redactan credenciales.
      logger.info('turn', { phone: '5493532401540', customerName: 'Mathew' });

      expect(lastEntry().phone).toBe('5493532401540');
      expect(lastEntry().customerName).toBe('Mathew');
    });
  });

  describe('logEvent', () => {
    it('agrega el campo event y la etiqueta del catálogo', () => {
      logEvent('info', 'session.linked', { businessId: 'biz-1' });

      expect(lastEntry()).toMatchObject({
        event: 'session.linked',
        message: 'WhatsApp session linked',
        businessId: 'biz-1',
        level: 'info',
      });
    });
  });

  describe('contexto implícito', () => {
    it('inyecta el contexto en una línea emitida varios awaits más abajo', async () => {
      const deep = async () => {
        await Promise.resolve();
        await Promise.resolve();
        logger.debug('deep inside the turn');
      };

      await withLogContext({ conversationId: 'biz-1-549353', businessId: 'biz-1' }, deep);

      expect(lastEntry()).toMatchObject({
        conversationId: 'biz-1-549353',
        businessId: 'biz-1',
      });
    });

    it('mergea contextos anidados sin perder el del padre', async () => {
      await withLogContext({ requestId: 'req-1' }, async () => {
        await withLogContext({ businessId: 'biz-2' }, async () => {
          expect(currentLogContext()).toEqual({ requestId: 'req-1', businessId: 'biz-2' });
        });
      });
    });

    it('no filtra contexto entre cadenas async paralelas', async () => {
      const emit = (id: string) =>
        withLogContext({ conversationId: id }, async () => {
          await new Promise((r) => setTimeout(r, id === 'a' ? 20 : 1));
          logger.debug('done');
          return lastEntry().conversationId;
        });

      const [a, b] = await Promise.all([emit('a'), emit('b')]);
      expect(b).toBe('b');
      expect(a).toBe('a');
    });

    it('fuera de un contexto no agrega campos', () => {
      logger.debug('standalone');
      expect(lastEntry().conversationId).toBeUndefined();
    });
  });
});

describe('log-throttle', () => {
  beforeEach(() => resetThrottle());

  it('deja pasar la primera y suprime las siguientes dentro de la ventana', () => {
    expect(throttle('k', 60_000).allowed).toBe(true);
    expect(throttle('k', 60_000).allowed).toBe(false);
    expect(throttle('k', 60_000).allowed).toBe(false);
  });

  it('informa cuántas suprimió al volver a permitir', () => {
    jest.useFakeTimers();
    try {
      throttle('k', 1000);
      throttle('k', 1000);
      throttle('k', 1000);

      jest.advanceTimersByTime(1500);

      expect(throttle('k', 1000)).toEqual({ allowed: true, suppressed: 2 });
    } finally {
      jest.useRealTimers();
    }
  });

  it('mantiene las claves independientes entre sí', () => {
    expect(throttle('a').allowed).toBe(true);
    expect(throttle('b').allowed).toBe(true);
    expect(throttle('a').allowed).toBe(false);
  });
});
