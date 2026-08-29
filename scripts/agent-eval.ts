/**
 * 📊 Evals del agente v2 contra el modelo REAL
 *
 * Corre los escenarios de conversación de src/__tests__/scenarios contra el
 * orquestador y el modelo de verdad, y puntúa el resultado.
 *
 * Por qué no vive en el test suite: cuesta plata por corrida, tarda minutos y
 * la salida de un LLM no es determinista — como gate de CI sería flaky y caro.
 * Lo que sí es determinista, y por eso sí está en CI, son las tool calls
 * (src/__tests__/agent/). Acá se mide lo otro: si el modelo DECIDE bien.
 *
 * Corre siempre en dryRun: ninguna herramienta escribe, así que es seguro
 * apuntarlo a un negocio real. Lo que se puntúa son las decisiones del modelo
 * (qué herramientas llamó), no el estado que dejó.
 *
 * Uso:
 *   pnpm eval                    todos los escenarios
 *   pnpm eval happy_path         una categoría
 *   pnpm eval hp-01              un escenario puntual
 */

import * as dotenv from 'dotenv';
dotenv.config();

import { SupabaseConfig } from '../src/config/supabase';
import { RedisConfig } from '../src/config/redis';
import { OpenRouterConfig } from '../src/config/openrouter';
import { SupabaseService } from '../src/services/supabase.service';
import { handleTurn } from '../src/agent/orchestrator';
import { clearHistory } from '../src/agent/state';
import { runWithLanguage } from '../src/i18n';
import { ALL_SCENARIOS, ConversationScenario } from '../src/__tests__/scenarios/conversation-scenarios';
import { EnvConfig } from '../src/types';

const BUSINESS_ID = process.env.TEST_BUSINESS_ID;

if (!BUSINESS_ID) {
  console.error('❌ Configurá TEST_BUSINESS_ID en tu .env con el UUID de un negocio de PRUEBA.');
  process.exit(1);
}

interface TurnOutcome {
  user: string;
  reply: string;
  tools: string[];
  iterations: number;
  latencyMs: number;
  /** Fallos duros: lo que NO puede pasar bajo ninguna circunstancia. */
  violations: string[];
}

interface ScenarioOutcome {
  id: string;
  category: string;
  description: string;
  turns: TurnOutcome[];
  createdReservation: boolean;
  expectedReservation: boolean;
  totalLatencyMs: number;
  error?: string;
}

/**
 * Reglas duras. Son las que justifican el eval: un fraseo distinto no es un
 * fallo (v2 redacta cada vez), pero crear una reserva cuando el escenario
 * espera un bloqueo sí lo es.
 */
function checkViolations(
  reply: string,
  tools: string[],
  expect: ConversationScenario['turns'][number]['expect']
): string[] {
  const violations: string[] = [];

  if (!reply.trim()) {
    violations.push('respuesta vacía');
  }

  if (expect.isBlocked && tools.includes('create_reservation')) {
    violations.push('creó una reserva cuando debía bloquear');
  }

  if (expect.isOffTopic && tools.includes('create_reservation')) {
    violations.push('creó una reserva ante un mensaje fuera de tema');
  }

  // notContains sigue siendo válido en v2: son cosas que el bot no debe decir
  // nunca (datos inventados, disculpas por capacidades que sí tiene), no fraseo.
  for (const forbidden of expect.notContains ?? []) {
    if (reply.toLowerCase().includes(forbidden.toLowerCase())) {
      violations.push(`dijo "${forbidden}"`);
    }
  }

  return violations;
}

async function runScenario(scenario: ConversationScenario): Promise<ScenarioOutcome> {
  const phone = `eval${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const conversationId = `${BUSINESS_ID}-${phone}`;
  await clearHistory(conversationId);

  const outcome: ScenarioOutcome = {
    id: scenario.id,
    category: scenario.category,
    description: scenario.description,
    turns: [],
    createdReservation: false,
    expectedReservation: scenario.turns.some((t) => t.expect.reservationCreated === true),
    totalLatencyMs: 0,
  };

  try {
    for (const turn of scenario.turns) {
      const startedAt = Date.now();

      const result = await runWithLanguage('es', () =>
        handleTurn({
          businessId: BUSINESS_ID as string,
          conversationId,
          phone,
          jid: `${phone}@s.whatsapp.net`,
          messageText: turn.user,
          language: 'es',
          businessName: scenario.businessName ?? 'La Parrilla',
          // Nunca escribe: el eval puntúa decisiones, no estado.
          dryRun: true,
        })
      );

      const latencyMs = Date.now() - startedAt;
      const reply = result.messages.join(' ');

      if (result.toolsCalled.includes('create_reservation')) {
        outcome.createdReservation = true;
      }

      outcome.turns.push({
        user: turn.user,
        reply,
        tools: result.toolsCalled,
        iterations: result.iterations,
        latencyMs,
        violations: checkViolations(reply, result.toolsCalled, turn.expect),
      });
      outcome.totalLatencyMs += latencyMs;
    }
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : String(error);
  }

  await clearHistory(conversationId);
  return outcome;
}

function report(outcomes: ScenarioOutcome[]): void {
  const violations = outcomes.flatMap((o) =>
    o.turns.flatMap((t) => t.violations.map((v) => ({ id: o.id, turn: t.user, violation: v })))
  );
  const errored = outcomes.filter((o) => o.error);
  const shouldReserve = outcomes.filter((o) => o.expectedReservation);
  const didReserve = shouldReserve.filter((o) => o.createdReservation);

  const allTurns = outcomes.flatMap((o) => o.turns);
  const avgLatency = allTurns.length
    ? Math.round(allTurns.reduce((sum, t) => sum + t.latencyMs, 0) / allTurns.length)
    : 0;
  const avgIterations = allTurns.length
    ? (allTurns.reduce((sum, t) => sum + t.iterations, 0) / allTurns.length).toFixed(2)
    : '0';

  console.log('\n' + '='.repeat(70));
  console.log('RESULTADO');
  console.log('='.repeat(70));
  console.log(`Escenarios corridos      ${outcomes.length}`);
  console.log(`Con error de ejecución   ${errored.length}`);
  console.log(
    `Completitud de reserva   ${didReserve.length}/${shouldReserve.length}` +
      (shouldReserve.length ? ` (${Math.round((didReserve.length / shouldReserve.length) * 100)}%)` : '')
  );
  console.log(`Violaciones de regla     ${violations.length}   ← tiene que ser 0`);
  console.log(`Latencia media por turno ${avgLatency}ms`);
  console.log(`Iteraciones por turno    ${avgIterations}`);

  if (violations.length > 0) {
    console.log('\n--- VIOLACIONES ---');
    for (const v of violations) {
      console.log(`  [${v.id}] "${v.turn}" → ${v.violation}`);
    }
  }

  if (errored.length > 0) {
    console.log('\n--- ERRORES ---');
    for (const o of errored) {
      console.log(`  [${o.id}] ${o.error}`);
    }
  }

  const incomplete = shouldReserve.filter((o) => !o.createdReservation);
  if (incomplete.length > 0) {
    console.log('\n--- NO COMPLETARON LA RESERVA ---');
    for (const o of incomplete) {
      console.log(`  [${o.id}] ${o.description}`);
      for (const t of o.turns) {
        console.log(`      🧑 ${t.user}`);
        console.log(`      🤖 ${t.reply.slice(0, 120).replace(/\n/g, ' ')}`);
        console.log(`         tools: ${t.tools.join(', ') || '—'}`);
      }
    }
  }

  console.log('\nGate de promoción: 0 violaciones y completitud >= la de v1.\n');
}

async function main(): Promise<void> {
  SupabaseConfig.initialize(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
  await RedisConfig.initialize(process.env.REDIS_URL || 'redis://localhost:6379');
  OpenRouterConfig.initialize({
    openRouterApiKey: process.env.OPENROUTER_API_KEY as string,
    openRouterModel: process.env.OPENROUTER_MODEL || 'openrouter/auto',
    openRouterFallbackModels: [],
    openRouterTimeout: parseInt(process.env.OPENROUTER_TIMEOUT || '30000', 10),
    // Sólo se usan los campos de OpenRouter; el resto de EnvConfig no interviene
    // en el eval, así que el cast va por `unknown` en vez de armar un objeto falso.
  } as unknown as EnvConfig);

  const business = await SupabaseService.getBusinessById(BUSINESS_ID as string);
  if (!business) {
    console.error(`❌ No encontré el negocio ${BUSINESS_ID}.`);
    process.exit(1);
  }

  const filter = process.argv[2];
  const scenarios = filter
    ? ALL_SCENARIOS.filter((s) => s.category === filter || s.id === filter)
    : ALL_SCENARIOS;

  if (scenarios.length === 0) {
    console.error(`❌ Ningún escenario coincide con "${filter}".`);
    process.exit(1);
  }

  console.log(`\n🤖 Modelo: ${process.env.OPENROUTER_MODEL}`);
  console.log(`🏪 Negocio: ${business.name}`);
  console.log(`📋 Escenarios: ${scenarios.length}`);
  console.log('⚠️  dryRun activo — no se escribe nada en la base.\n');

  const outcomes: ScenarioOutcome[] = [];
  for (const [index, scenario] of scenarios.entries()) {
    process.stdout.write(`[${index + 1}/${scenarios.length}] ${scenario.id} `);
    const outcome = await runScenario(scenario);
    outcomes.push(outcome);

    const failures = outcome.turns.reduce((n, t) => n + t.violations.length, 0);
    console.log(outcome.error ? '💥' : failures > 0 ? `❌ ${failures}` : '✅');
  }

  report(outcomes);
  await RedisConfig.disconnect();
  process.exit(outcomes.some((o) => o.turns.some((t) => t.violations.length > 0)) ? 1 : 0);
}

main().catch((error) => {
  console.error('💥 Eval falló:', error);
  process.exit(1);
});
