/**
 * 🗣️ Eval de los locales de número compartido contra el modelo REAL
 *
 * Mide si el modelo reconoce lo que NO es para el bot — el amigo que le
 * escribe a Simona, el empleado que avisa que falta, el proveedor, el bot de
 * otra empresa — y lo deriva con `hand_off_to_human` sin decir nada, y si al
 * mismo tiempo sigue atendiendo a los clientes que vienen a reservar.
 *
 * Los mensajes salen de los logs de producción de De La Fonte (29 y 30/09),
 * con nombres y datos personales cambiados.
 *
 * Igual que `agent-eval.ts`, no vive en el test suite: cuesta plata por
 * corrida y la salida del modelo no es determinista. La mecánica (qué pasa
 * cuando el modelo deriva) sí está en CI: src/__tests__/agent/human-handoff.test.ts.
 *
 * Corre siempre en dryRun contra los comercios reales de cada adaptación:
 * ninguna herramienta escribe (ni reservas, ni traspasos), sólo se lee la
 * configuración del local. El historial va al namespace de dry-run y se borra
 * al terminar cada caso.
 *
 * CUESTA PLATA: cada caso es un turno real contra OpenRouter (una o dos
 * llamadas de ~5.000 tokens). Sin `--confirmar` sólo muestra cuántos turnos
 * correría. Los casos van de a uno, sin ráfagas en paralelo: con saldo bajo,
 * varias requests a la vez chocan contra el límite "in flight" de OpenRouter
 * (402) — y ese saldo es el mismo que usa el bot en producción.
 *
 * Uso:
 *   npx ts-node scripts/handoff-eval.ts                        cuántos turnos haría (gratis)
 *   npx ts-node scripts/handoff-eval.ts --confirmar            los cuatro locales
 *   npx ts-node scripts/handoff-eval.ts antigal --confirmar    uno solo (id de la adaptación)
 *   EVAL_REPEAT=3 npx ts-node scripts/handoff-eval.ts --confirmar   cada caso tres veces
 */

import * as dotenv from 'dotenv';
dotenv.config();

import { SupabaseConfig } from '../src/config/supabase';
import { RedisConfig } from '../src/config/redis';
import { OpenRouterConfig } from '../src/config/openrouter';
import { SupabaseService } from '../src/services/supabase.service';
import { handleTurn } from '../src/agent/orchestrator';
import { clearHistory, saveHistory } from '../src/agent/state';
import { runWithLanguage } from '../src/i18n';
import { antigalAdaptation } from '../src/adaptations/antigal';
import { deLaFonteAdaptation } from '../src/adaptations/de-la-fonte';
import { laMisionAdaptation } from '../src/adaptations/la-mision';
import { skyAdaptation } from '../src/adaptations/sky';
import type { SharedNumberAdaptation } from '../src/adaptations';
import { EnvConfig, LlmMessage } from '../src/types';

/**
 * `handoff`: tiene que derivar. `answer`: tiene que contestar algo.
 * `keep`: no tiene que derivar, pero puede no decir nada (un "gracias" al
 * cierre de una reserva, que el prompt pide no contestar).
 */
type Expected = 'handoff' | 'answer' | 'keep';

interface EvalCase {
  text: string;
  expected: Expected;
  /** Lo que ya se habló antes de este mensaje. */
  history?: LlmMessage[];
  /** Sólo para estos locales (id de la adaptación). */
  only?: string[];
}

const CASES: EvalCase[] = [
  // ─── No es para el bot: lo que el bot le contestaba en producción ───
  { expected: 'handoff', text: 'holaa simo todo bien? mañana después del mediodía paso por tu casa y vemos eso que querías' },
  { expected: 'handoff', text: 'Chicos mañana faltoo' },
  { expected: 'handoff', text: 'Buen día Sra, necesitamos que se acerque a la escuela a firmar un papel de la alumna Lucía' },
  { expected: 'handoff', text: 'Ingresa pasajero de la habitación 4, abona con tarjeta de crédito $538.758' },
  { expected: 'handoff', text: '¡Hola! Soy Gasti, el asistente virtual de la empresa de gas 🤖. Tu DEBIN ya fue generado: aceptalo desde tu home banking.' },
  { expected: 'handoff', text: 'Passando pra ver se está precisando de algo pra essa semana?' },
  { expected: 'handoff', text: 'La caja de hoy señora' },
  { expected: 'handoff', text: 'Ok señora' },
  { expected: 'handoff', text: 'Esponja de acero sería' },
  { expected: 'handoff', text: 'Buen día! Soy de la distribuidora de bebidas, ¿les hace falta algo esta semana?' },
  { expected: 'handoff', text: 'Hola, quería saber si están buscando personal para la temporada, les puedo mandar mi CV' },
  { expected: 'handoff', text: 'Hola! Perdón la molestia pero necesito saber si va a estar lista para hoy mi camioneta' },
  { expected: 'handoff', text: 'Quiero hablar con una persona, no con un bot' },
  { expected: 'handoff', text: '¿Me podés transferir un toque? Te paso el alias' },
  { expected: 'handoff', text: 'Jajaja qué buena foto, ¿dónde era eso?' },
  { expected: 'handoff', text: 'Le pregunto al técnico cuándo viene a ver el aire de la habitación' },
  {
    expected: 'handoff',
    text: 'Passando pra ver se está precisando de algo pra essa semana?',
    // Lo que pasó de verdad: el proveedor saludó, recibió el menú y siguió.
    history: [
      { role: 'user', content: 'Bom dia' },
      { role: 'assistant', content: '__WELCOME__' },
    ],
  },
  { expected: 'handoff', text: 'Buenos días Sra' },
  // Un "👍🏻👍🏻👍🏻" suelto ya no llega al modelo: lo calla el handler antes
  // (ver CONTENT_PATTERN en whatsapp-handler.service.ts). Era el único caso
  // que el modelo fallaba (12 de 447 en la corrida del 30/09).
  { expected: 'handoff', text: 'Hola, soy Carla la contadora, te mando las facturas de septiembre' },
  { expected: 'handoff', text: 'Mañana no voy a poder ir a trabajar, estoy con fiebre' },
  { expected: 'handoff', text: 'Hola Vale! ¿Cómo andás? ¿Nos vemos el sábado?', only: ['antigal'] },
  { expected: 'handoff', text: '¿A qué hora es el check-in?', only: ['lamision'] },
  { expected: 'handoff', text: 'Necesito una habitación doble para el fin de semana', only: ['lamision'] },

  // ─── Es para el bot: un cliente que viene a reservar o pregunta del restaurante ───
  // SKY (`inquiryGuidance`): el cliente que consulta por algo ajeno a la reserva se contesta.
  { expected: 'answer', text: 'Hola, quería preguntar por un evento privado', only: ['sky'] },
  { expected: 'answer', text: 'Hola, quería consultar por un evento privado para 60 personas', only: ['sky'] },
  { expected: 'answer', text: 'Hola, quiero reservar una mesa para 4 el sábado a las 21' },
  { expected: 'answer', text: '¿A qué hora abren hoy?' },
  { expected: 'answer', text: '¿Dónde están ubicados?' },
  { expected: 'answer', text: 'Buenas noches, ¿tienen lugar para 2 personas hoy?' },
  { expected: 'answer', text: 'Quisiera cancelar mi reserva' },
  { expected: 'answer', text: 'Hola! ¿Tienen opciones sin TACC?' },
  { expected: 'answer', text: 'Reservar' },
  { expected: 'answer', text: 'Buenas! ¿Hacen reservas para grupos? Somos 12 para el viernes' },
  {
    expected: 'answer',
    text: 'somos 4',
    history: [
      { role: 'user', content: 'quiero reservar para mañana a las 21' },
      { role: 'assistant', content: '¡Perfecto! ¿Para cuántas personas sería la reserva?' },
    ],
  },
  {
    expected: 'answer',
    text: 'ok, el viernes a las 21',
    history: [
      { role: 'user', content: 'Reservar' },
      { role: 'assistant', content: '¡Genial! ¿Para qué día y horario querés la mesa?' },
    ],
  },
  { expected: 'answer', text: 'Quiero reservar en el restaurante para esta noche, somos 2', only: ['lamision'] },
  // Clientes con tono cálido: la cortesía no los vuelve "conocidos de la persona".
  { expected: 'answer', text: 'Hola! Buenas noches 😊 ¿Tienen mesa para hoy?' },
  { expected: 'answer', text: 'Hola, ¿cómo estás? Quería saber si abren el domingo' },
  { expected: 'answer', text: 'Buenas tardes, ¿me pasás la carta?' },
  {
    expected: 'keep',
    text: 'Gracias!',
    history: [
      { role: 'user', content: 'mesa para 2 hoy a las 21, a nombre de Gómez' },
      { role: 'assistant', content: 'Listo, Gómez: mesa para 2 hoy a las 21. Código *K7Q2*.' },
    ],
  },
  {
    expected: 'keep',
    text: 'ok',
    history: [
      { role: 'user', content: '¿a qué hora cierran la cocina?' },
      { role: 'assistant', content: 'La cocina toma pedidos hasta las 23:15.' },
    ],
  },
];

const ADAPTATIONS: SharedNumberAdaptation[] = [
  deLaFonteAdaptation,
  antigalAdaptation,
  skyAdaptation,
  laMisionAdaptation,
];

interface Outcome {
  adaptation: string;
  text: string;
  expected: Expected;
  handedOff: boolean;
  reply: string;
  tools: string[];
  error?: string;
}

function passed(o: Outcome): boolean {
  if (o.error) return false;
  if (o.expected === 'handoff') return o.handedOff;
  if (o.expected === 'keep') return !o.handedOff;
  return !o.handedOff && o.reply.trim().length > 0;
}

async function runCase(
  adaptation: SharedNumberAdaptation,
  businessId: string,
  businessName: string,
  evalCase: EvalCase
): Promise<Outcome> {
  const phone = `eval${Date.now()}${Math.floor(Math.random() * 100000)}`;
  const conversationId = `${businessId}-${phone}`;
  const outcome: Outcome = {
    adaptation: adaptation.id,
    text: evalCase.text,
    expected: evalCase.expected,
    handedOff: false,
    reply: '',
    tools: [],
  };

  try {
    if (evalCase.history) {
      const history = evalCase.history.map((m) =>
        m.content === '__WELCOME__' ? { ...m, content: adaptation.welcome(null, []) } : m
      );
      await saveHistory(conversationId, history, true);
    }

    const result = await runWithLanguage('es', () =>
      handleTurn({
        businessId,
        conversationId,
        phone,
        jid: `${phone}@s.whatsapp.net`,
        messageText: evalCase.text,
        language: 'es',
        businessName,
        humanContext: adaptation.humanContext,
        inquiryGuidance: adaptation.inquiryGuidance,
        // Nunca escribe: ni reservas ni traspasos.
        dryRun: true,
      })
    );

    outcome.handedOff = result.handedOff === true;
    outcome.reply = result.messages.join(' | ');
    outcome.tools = result.toolsCalled;
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : String(error);
  } finally {
    await clearHistory(conversationId);
  }

  return outcome;
}

async function runAdaptation(adaptation: SharedNumberAdaptation, repeat: number): Promise<Outcome[]> {
  const businessId = (process.env[adaptation.businessIdEnvVar] ?? '').split(',')[0]?.trim();
  if (!businessId) {
    console.log(`⚠️  ${adaptation.id}: falta ${adaptation.businessIdEnvVar}, se saltea.`);
    return [];
  }

  const business = await SupabaseService.getBusinessById(businessId);
  if (!business) {
    console.log(`⚠️  ${adaptation.id}: no encontré el comercio ${businessId}, se saltea.`);
    return [];
  }

  const cases = CASES.filter((c) => !c.only || c.only.includes(adaptation.id));
  const outcomes: Outcome[] = [];
  for (let round = 0; round < repeat; round++) {
    for (const evalCase of cases) {
      const outcome = await runCase(adaptation, businessId, business.name, evalCase);
      outcomes.push(outcome);
      process.stdout.write(passed(outcome) ? '.' : 'F');
    }
  }
  return outcomes;
}

function report(outcomes: Outcome[]): void {
  console.log('\n\n' + '='.repeat(78));
  console.log('RESULTADO');
  console.log('='.repeat(78));

  const byAdaptation = new Map<string, Outcome[]>();
  for (const o of outcomes) {
    byAdaptation.set(o.adaptation, [...(byAdaptation.get(o.adaptation) ?? []), o]);
  }

  for (const [id, list] of byAdaptation) {
    const handoffs = list.filter((o) => o.expected === 'handoff');
    const answers = list.filter((o) => o.expected !== 'handoff');
    console.log(
      `${id.padEnd(10)}  no era para el bot → derivó: ${handoffs.filter(passed).length}/${handoffs.length}` +
        `   cliente → lo atendió: ${answers.filter(passed).length}/${answers.length}`
    );
  }

  const failures = outcomes.filter((o) => !passed(o));
  if (failures.length > 0) {
    console.log('\n--- FALLOS ---');
    for (const f of failures) {
      const what = f.expected === 'handoff' ? 'debía derivar y CONTESTÓ' : 'debía atender y DERIVÓ';
      console.log(`  [${f.adaptation}] ${what}: "${f.text}"`);
      if (f.error) console.log(`      💥 ${f.error}`);
      else console.log(`      🤖 ${f.reply.slice(0, 160).replace(/\n/g, ' ') || '(nada)'}  tools: ${f.tools.join(', ') || '—'}`);
    }
  }

  const total = outcomes.length;
  console.log(`\nTotal: ${total - failures.length}/${total} correctos.\n`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const confirmed = args.includes('--confirmar');
  const filter = args.find((arg) => !arg.startsWith('--'));
  const adaptations = filter ? ADAPTATIONS.filter((a) => a.id === filter) : ADAPTATIONS;
  if (adaptations.length === 0) {
    console.error(`❌ Ninguna adaptación se llama "${filter}".`);
    process.exit(1);
  }
  const repeat = Math.max(1, parseInt(process.env.EVAL_REPEAT || '1', 10));
  const turns =
    repeat *
    adaptations.reduce(
      (sum, a) => sum + CASES.filter((c) => !c.only || c.only.includes(a.id)).length,
      0
    );

  console.log(`\n🤖 Modelo: ${process.env.OPENROUTER_MODEL}`);
  console.log(`🏪 Locales: ${adaptations.map((a) => a.id).join(', ')}  ·  repeticiones: ${repeat}`);
  console.log(`💸 ${turns} turnos contra OpenRouter (entre ${turns} y ${turns * 2} llamadas).`);

  if (!confirmed) {
    console.log('\nNo se corrió nada. Para correrlo de verdad, agregá --confirmar.\n');
    process.exit(0);
  }
  console.log('⚠️  dryRun activo — no se escribe nada.\n');

  SupabaseConfig.initialize(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
  await RedisConfig.initialize(process.env.REDIS_URL || 'redis://localhost:6379');
  OpenRouterConfig.initialize({
    openRouterApiKey: process.env.OPENROUTER_API_KEY as string,
    openRouterModel: process.env.OPENROUTER_MODEL || 'openrouter/auto',
    openRouterFallbackModels: [],
    openRouterTimeout: parseInt(process.env.OPENROUTER_TIMEOUT || '30000', 10),
  } as unknown as EnvConfig);

  // De a un local y de a un caso: nada en paralelo (ver la nota del 402 arriba).
  const outcomes: Outcome[] = [];
  for (const adaptation of adaptations) {
    outcomes.push(...(await runAdaptation(adaptation, repeat)));
  }

  report(outcomes);
  await RedisConfig.disconnect();
  process.exit(outcomes.some((o) => !passed(o)) ? 1 : 0);
}

main().catch((error) => {
  console.error('💥 Eval falló:', error);
  process.exit(1);
});
