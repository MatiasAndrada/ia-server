import { SupabaseService } from '../../services/supabase.service.js';

jest.mock('../../utils/logger');

/**
 * El mismo cliente puede estar cargado con o sin el 9 de los móviles
 * argentinos: el bot crea la ficha desde el JID (`549…`) y el personal la
 * carga desde el panel muchas veces sin el 9 (`54…`). Antes la búsqueda era
 * por igualdad exacta: el bot no veía las reservas que había cargado el
 * personal, y el alta duplicaba la ficha.
 */

const BUSINESS_ID = 'biz-phone';
const WITH_9 = '5493757441049';
const WITHOUT_9 = '543757441049';

type Row = Record<string, any>;

/** Un cliente de Supabase mínimo que filtra de verdad por `eq` e `in`. */
function fakeSupabase(tables: Record<string, Row[]>) {
  const inserted: Row[] = [];

  function run(table: string, ops: Array<[string, any[]]>) {
    const insert = ops.find(([op]) => op === 'insert');
    if (insert) {
      const row = { id: `new-${inserted.length + 1}`, ...insert[1][0] };
      inserted.push(row);
      return { data: row, error: null };
    }

    let rows = tables[table] ?? [];
    for (const [op, args] of ops) {
      if (op === 'eq') rows = rows.filter((row) => row[args[0]] === args[1]);
      if (op === 'in') rows = rows.filter((row) => (args[1] as unknown[]).includes(row[args[0]]));
    }

    const update = ops.find(([op]) => op === 'update');
    if (update) rows = rows.map((row) => ({ ...row, ...update[1][0] }));

    const single = ops.some(([op]) => op === 'single' || op === 'maybeSingle');
    return { data: single ? rows[0] ?? null : rows, error: null };
  }

  const client = {
    from(table: string) {
      const ops: Array<[string, any[]]> = [];
      const chain: any = new Proxy(
        {},
        {
          get(_target, prop) {
            if (prop === 'then') {
              return (resolve: (v: unknown) => void, reject: (e: unknown) => void) =>
                Promise.resolve(run(table, ops)).then(resolve, reject);
            }
            return (...args: any[]) => {
              ops.push([String(prop), args]);
              return chain;
            };
          },
        }
      );
      return chain;
    },
  };

  jest.spyOn(SupabaseService as any, 'getClient').mockReturnValue(client);
  return { inserted };
}

describe('SupabaseService — clientes con y sin el 9', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
  });

  it('el bot encuentra al cliente que el personal cargó sin el 9', async () => {
    fakeSupabase({
      customers: [{ id: 'c-panel', business_id: BUSINESS_ID, phone: WITHOUT_9, name: 'Ana' }],
    });

    const customer = await SupabaseService.getCustomerByPhone(WITH_9, BUSINESS_ID);

    expect(customer).toMatchObject({ id: 'c-panel', name: 'Ana' });
  });

  it('con una ficha de cada forma, prefiere la del formato exacto', async () => {
    fakeSupabase({
      customers: [
        { id: 'c-panel', business_id: BUSINESS_ID, phone: WITHOUT_9, name: 'Ana' },
        { id: 'c-bot', business_id: BUSINESS_ID, phone: WITH_9, name: 'Ana María' },
      ],
    });

    expect(await SupabaseService.getCustomerByPhone(WITH_9, BUSINESS_ID)).toMatchObject({ id: 'c-bot' });
    expect(await SupabaseService.getCustomerByPhone(WITHOUT_9, BUSINESS_ID)).toMatchObject({
      id: 'c-panel',
    });
  });

  it('ve las reservas activas de las dos fichas: las que cargó el personal también se pueden cancelar', async () => {
    fakeSupabase({
      customers: [
        { id: 'c-panel', business_id: BUSINESS_ID, phone: WITHOUT_9 },
        { id: 'c-bot', business_id: BUSINESS_ID, phone: WITH_9 },
      ],
      waitlist_entries: [
        { id: 'r-panel', customer_id: 'c-panel', business_id: BUSINESS_ID, status: 'CONFIRMED', queued_at: '2026-10-01T10:00:00Z' },
        { id: 'r-bot', customer_id: 'c-bot', business_id: BUSINESS_ID, status: 'WAITING', queued_at: '2026-10-01T12:00:00Z' },
      ],
    });

    const reservations = await SupabaseService.getActiveReservationsByPhone(WITH_9, BUSINESS_ID);

    expect(reservations.map((r) => r.id)).toEqual(['r-bot', 'r-panel']);
  });

  it('el alta reutiliza la ficha que cargó el personal en vez de duplicarla', async () => {
    const { inserted } = fakeSupabase({
      customers: [{ id: 'c-panel', business_id: BUSINESS_ID, phone: WITHOUT_9, name: 'Ana' }],
    });

    const customer = await SupabaseService.getOrCreateCustomer('Ana', WITH_9, BUSINESS_ID);

    expect(customer.id).toBe('c-panel');
    expect(inserted).toHaveLength(0);
  });

  it('un número que no está en ningún formato se da de alta como siempre', async () => {
    const { inserted } = fakeSupabase({ customers: [] });

    await SupabaseService.getOrCreateCustomer('Ana', WITH_9, BUSINESS_ID);

    expect(inserted).toEqual([expect.objectContaining({ phone: WITH_9, business_id: BUSINESS_ID })]);
  });

  it('no mezcla clientes de otro comercio', async () => {
    fakeSupabase({
      customers: [{ id: 'c-otro', business_id: 'otro-comercio', phone: WITH_9 }],
    });

    expect(await SupabaseService.getCustomerByPhone(WITH_9, BUSINESS_ID)).toBeNull();
  });
});
