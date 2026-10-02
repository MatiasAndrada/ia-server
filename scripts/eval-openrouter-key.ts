/**
 * La key de OpenRouter de los scripts que llaman al modelo real (los evals y
 * el simulador de chat). Nunca la de producción.
 *
 * Es el mismo saldo: el 30/09/2026 un eval corrido con la key del bot agotó el
 * presupuesto en vuelo (402 `in_flight_budget_exhausted`) y, mientras tanto,
 * los clientes de todos los locales recibían el mensaje de "no disponible".
 * Con una key propia — con su propio límite, creada en OpenRouter — un eval
 * puede quedarse sin saldo sin tocar al bot.
 */
export function evalOpenRouterKey(): string {
  const evalKey = process.env.OPENROUTER_EVAL_API_KEY?.trim();
  const productionKey = process.env.OPENROUTER_API_KEY?.trim();

  if (!evalKey) {
    console.error(
      '❌ Falta OPENROUTER_EVAL_API_KEY en el .env: una key de OpenRouter sólo para pruebas, con su ' +
        'propio límite de gasto. Este script no usa la key de producción.'
    );
    process.exit(1);
  }

  if (evalKey === productionKey) {
    console.error(
      '❌ OPENROUTER_EVAL_API_KEY es la misma key que usa el bot en producción. Creá una aparte en ' +
        'OpenRouter, con su propio límite de gasto.'
    );
    process.exit(1);
  }

  return evalKey;
}
