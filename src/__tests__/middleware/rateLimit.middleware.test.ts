/**
 * G-06: el rate limit se contaba por IP, y como todo el tráfico llega desde el
 * mismo backend, todos los negocios compartían un único balde de 100 req/min.
 *
 * El caso que más importa acá es el del panel: manda el businessId en la URL y
 * sin body, y el limiter se monta con `use()` sobre `/api` — donde `req.params`
 * está VACÍO. Un keyGenerator que solo mirara params/body degradaría a IP en el
 * 100% de ese tráfico y el bug quedaría igual que antes.
 */

import express from 'express';
import rateLimit from 'express-rate-limit';
import request from 'supertest';
import { Request } from 'express';
import { resolveRateLimitKey } from '../../middleware/rateLimit.middleware.js';

jest.mock('../../utils/logger');

const BIZ_A = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
const BIZ_B = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

/** Request mínimo con la forma que mira resolveRateLimitKey. */
function req(overrides: Partial<Request>): Request {
  return { params: {}, body: {}, ip: '10.0.0.1', originalUrl: '/', url: '/', ...overrides } as Request;
}

describe('resolveRateLimitKey', () => {
  it('usa el businessId de la URL en las rutas de sesiones (params vacío, sin body)', () => {
    // El caso real del panel — y el que rompía el diseño ingenuo.
    expect(
      resolveRateLimitKey(req({ originalUrl: `/api/sessions/${BIZ_A}/status` }))
    ).toBe(`biz:${BIZ_A}`);
  });

  it('también lo rescata en las rutas de mensajes', () => {
    expect(resolveRateLimitKey(req({ originalUrl: `/api/messages/${BIZ_A}` }))).toBe(`biz:${BIZ_A}`);
    expect(
      resolveRateLimitKey(req({ originalUrl: `/api/messages/${BIZ_A}/send` }))
    ).toBe(`biz:${BIZ_A}`);
  });

  it('prioriza req.params cuando el limiter se adjunta a una ruta concreta', () => {
    expect(resolveRateLimitKey(req({ params: { businessId: BIZ_A } }))).toBe(`biz:${BIZ_A}`);
  });

  it('usa el businessId del body en /api/chat', () => {
    expect(
      resolveRateLimitKey(req({ originalUrl: '/api/chat', body: { businessId: BIZ_B } }))
    ).toBe(`biz:${BIZ_B}`);
  });

  it('ignora query params al parsear el path', () => {
    expect(
      resolveRateLimitKey(req({ originalUrl: `/api/messages/${BIZ_A}?limit=50` }))
    ).toBe(`biz:${BIZ_A}`);
  });

  describe('cae a IP cuando no hay negocio identificable', () => {
    it('en el listado de sesiones, que no tiene segmento de id', () => {
      expect(resolveRateLimitKey(req({ originalUrl: '/api/sessions', ip: '1.2.3.4' }))).toBe('ip:1.2.3.4');
    });

    it('en /api/batch, porque un request puede abarcar varios negocios', () => {
      const key = resolveRateLimitKey(
        req({
          originalUrl: '/api/batch',
          ip: '1.2.3.4',
          body: { messages: [{ businessId: BIZ_A }, { businessId: BIZ_B }] },
        })
      );
      expect(key).toBe('ip:1.2.3.4');
    });

    it('con un body malformado (el limiter corre antes de validate())', () => {
      expect(resolveRateLimitKey(req({ originalUrl: '/api/batch', body: 'no-soy-un-objeto' as never }))).toBe(
        'ip:10.0.0.1'
      );
      expect(resolveRateLimitKey(req({ originalUrl: '/api/batch', body: undefined }))).toBe('ip:10.0.0.1');
    });

    it('con un businessId vacío o demasiado corto para ser real', () => {
      expect(resolveRateLimitKey(req({ params: { businessId: '' } }))).toBe('ip:10.0.0.1');
      expect(resolveRateLimitKey(req({ body: { businessId: 'abc' } }))).toBe('ip:10.0.0.1');
    });
  });

  it('un businessId nunca colisiona con una IP', () => {
    // Sin los prefijos biz:/ip:, un id que casualmente fuera una IP compartiría balde.
    const asBusiness = resolveRateLimitKey(req({ params: { businessId: '192.168.1.100' } }));
    const asIp = resolveRateLimitKey(req({ ip: '192.168.1.100' }));
    expect(asBusiness).not.toBe(asIp);
  });
});

describe('aislamiento real del balde entre negocios', () => {
  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use(
      '/api',
      rateLimit({
        windowMs: 60_000,
        max: 2,
        keyGenerator: resolveRateLimitKey,
        standardHeaders: true,
        legacyHeaders: false,
      })
    );
    app.get('/api/sessions/:businessId/status', (_req, res) => {
      res.json({ ok: true });
    });
    return app;
  }

  it('agotar el límite de un negocio no afecta a otro', async () => {
    const app = buildApp();

    // Negocio A quema sus 2 requests.
    await request(app).get(`/api/sessions/${BIZ_A}/status`).expect(200);
    await request(app).get(`/api/sessions/${BIZ_A}/status`).expect(200);
    await request(app).get(`/api/sessions/${BIZ_A}/status`).expect(429);

    // Negocio B, misma IP, sigue con su balde intacto — esto es todo el punto de G-06.
    await request(app).get(`/api/sessions/${BIZ_B}/status`).expect(200);
    await request(app).get(`/api/sessions/${BIZ_B}/status`).expect(200);
    await request(app).get(`/api/sessions/${BIZ_B}/status`).expect(429);
  });

  it('el mismo negocio sí comparte balde entre requests', async () => {
    const app = buildApp();

    await request(app).get(`/api/sessions/${BIZ_A}/status`).expect(200);
    await request(app).get(`/api/sessions/${BIZ_A}/status`).expect(200);
    await request(app).get(`/api/sessions/${BIZ_A}/status`).expect(429);
  });
});
