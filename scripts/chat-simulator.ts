/**
 * 💬 Simulador de conversación interactivo
 *
 * Terminal que habla directamente con el WhatsAppHandler real (el mismo que
 * procesa mensajes de WhatsApp en producción) sin pasar por Baileys ni por
 * ningún número de teléfono real. Ideal para probar el flujo de idiomas
 * (menú, detección, cambio mid-flow) o cualquier otro cambio sin exponer nada
 * a producción.
 *
 * Usa Supabase y Redis reales (los del .env), así que las reservas que crees
 * quedan guardadas de verdad — por eso requiere un TEST_BUSINESS_ID que
 * apunte a un negocio de prueba, no al real.
 *
 * Uso: npm run chat:simulate
 * Comandos dentro de la sesión:
 *   /reset          borra draft, historial e idioma cacheado (nueva conversación)
 *   /phone <numero> cambia el número de teléfono simulado
 *   /exit           salir
 */

import * as dotenv from 'dotenv';
dotenv.config();

import * as readline from 'readline';
import { randomUUID } from 'crypto';
import { SupabaseConfig } from '../src/config/supabase';
import { RedisConfig } from '../src/config/redis';
import { OpenRouterConfig } from '../src/config/openrouter';
import { WhatsAppHandler } from '../src/services/whatsapp-handler.service';
import { ReservationService } from '../src/services/reservation.service';
import { agentService } from '../src/services/agent.service';
import { SupabaseService } from '../src/services/supabase.service';
import { clearCachedLanguage } from '../src/i18n/language-store';
import { configureAgentMode, __setAgentModeForTests, isAgentV2Enabled } from '../src/agent/feature-flag';
import { resetConversation as resetAgentV2Conversation } from '../src/agent/orchestrator';
import { BaileysMessage, EnvConfig } from '../src/types';

const BUSINESS_ID = process.env.TEST_BUSINESS_ID;

if (!BUSINESS_ID) {
  console.error('❌ Configurá TEST_BUSINESS_ID en tu .env con el UUID de un negocio de PRUEBA.');
  console.error('   No uses el business_id real — este script crea reservas de verdad en Supabase.');
  process.exit(1);
}

if (!process.env.OPENROUTER_API_KEY) {
  console.error('❌ Configurá OPENROUTER_API_KEY en tu .env — lo necesita el fallback conversacional del agente.');
  process.exit(1);
}

let phone = process.env.TEST_PHONE || '5493540000000';

/**
 * Reemplaza a BaileysService: en vez de mandar el mensaje por WhatsApp real,
 * lo imprime en la terminal. Mismo patrón que los mocks del test suite
 * (src/__tests__/services/whatsapp-handler.service.test.ts).
 */
const stubBaileysService = {
  sendMessage: async (_businessId: string, jid: string, message: string): Promise<boolean> => {
    console.log(`\n🤖 Bot → ${jid}:\n${message}\n`);
    return true;
  },
  sendImageMessage: async (
    _businessId: string,
    jid: string,
    imageUrl: string,
    caption?: string
  ): Promise<boolean> => {
    console.log(`\n🖼️  Bot → ${jid}: [imagen] ${imageUrl}${caption ? `\n   caption: ${caption}` : ''}\n`);
    return true;
  },
  getSelfJid: (): string => '',
};

function buildMessage(text: string): BaileysMessage {
  return {
    from: `${phone}@s.whatsapp.net`,
    message: text,
    timestamp: Date.now(),
    businessId: BUSINESS_ID as string,
    messageId: `sim-${randomUUID()}`,
    fromMe: false,
  };
}

async function resetConversation(handler: WhatsAppHandler): Promise<void> {
  const conversationId = `${BUSINESS_ID}-${phone}`;
  await ReservationService.deleteDraft(conversationId);
  await agentService.clearConversationHistory(conversationId);
  // El agente v2 guarda su historial bajo otra key (`agent_v2:`), así que un
  // reset que sólo limpie la de v1 dejaría al v2 recordando la charla anterior.
  await resetAgentV2Conversation(conversationId);
  await clearCachedLanguage(BUSINESS_ID as string, phone);
  console.log('🔄 Conversación reiniciada (draft, historial e idioma cacheado borrados).');
  console.log('   El idioma guardado en customers.preferred_language NO se borra —');
  console.log('   así se comporta un cliente recurrente real. Para simular un cliente');
  console.log('   nunca visto, usá /phone con un número que no hayas usado antes.\n');
  void handler; // reservado por si el reset necesita tocar el handler más adelante
}

async function main(): Promise<void> {
  console.log('📦 Inicializando Supabase, Redis y OpenRouter...');
  SupabaseConfig.initialize(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
  await RedisConfig.initialize(process.env.REDIS_URL || 'redis://localhost:6379');
  // Sin esto, cualquier mensaje que caiga en el fallback conversacional del
  // agente (agentService.generateResponse -> openRouterService.chat) explota
  // con "OpenRouter client not initialized" — el mismo initialize() que hace
  // src/index.ts al arrancar el servidor real, acá replicado a mano porque
  // este script no pasa por ese bootstrap.
  OpenRouterConfig.initialize({
    openRouterApiKey: process.env.OPENROUTER_API_KEY as string,
    openRouterModel: process.env.OPENROUTER_MODEL || 'openrouter/auto',
    openRouterFallbackModels: (process.env.OPENROUTER_FALLBACK_MODELS || '')
      .split(',')
      .map((m) => m.trim())
      .filter(Boolean),
    openRouterTimeout: parseInt(process.env.OPENROUTER_TIMEOUT || '30000', 10),
    openRouterSiteUrl: process.env.OPENROUTER_SITE_URL,
    openRouterSiteName: process.env.OPENROUTER_SITE_NAME,
  } as EnvConfig);

  // El simulador no pasa por el bootstrap de src/index.ts, así que el modo del
  // agente se configura acá a mano. Se puede alternar en vivo con /mode.
  configureAgentMode(process.env.AGENT_MODE, process.env.AGENT_V2_BUSINESS_IDS);

  const business = await SupabaseService.getBusinessById(BUSINESS_ID as string);
  if (!business) {
    console.error(`❌ No encontré el negocio ${BUSINESS_ID} en Supabase. ¿Es un business_id de prueba válido?`);
    process.exit(1);
  }

  console.log(`✅ Conectado — Negocio: ${business.name}`);
  console.log(`📱 Simulando cliente: ${phone}`);
  console.log(`🔀 Modo del agente: ${isAgentV2Enabled(BUSINESS_ID as string) ? 'V2 (orquestador)' : 'V1 (pasos)'}`);
  console.log('\nComandos: /reset · /phone <numero> · /mode v1|v2 · /exit\n');

  const handler = new WhatsAppHandler(stubBaileysService as any);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '🧑 Vos > ',
  });
  rl.prompt();

  // Todas las líneas se serializan en esta cola. Sin esto, /exit dispara
  // rl.close() -> process.exit() ANTES de que termine el procesamiento async
  // del mensaje anterior, y la respuesta del bot nunca llega a imprimirse
  // (así se descubrió el bug: "hi" nunca mostraba la respuesta del menú).
  let queue: Promise<void> = Promise.resolve();

  async function handleLine(line: string): Promise<'exit' | void> {
    const text = line.trim();

    if (text === '/exit') {
      return 'exit';
    }

    if (text === '/reset') {
      await resetConversation(handler);
      return;
    }

    if (text.startsWith('/phone ')) {
      phone = text.slice('/phone '.length).trim();
      console.log(`📱 Ahora simulás como: ${phone}\n`);
      return;
    }

    // Alternar v1/v2 en vivo es la forma más directa de comparar: se manda el
    // mismo mensaje en los dos modos y se ve la diferencia de naturalidad.
    if (text === '/mode' || text.startsWith('/mode ')) {
      const requested = text.slice('/mode'.length).trim().toLowerCase();
      if (requested === 'v1' || requested === 'v2') {
        __setAgentModeForTests(requested, requested === 'v2' ? [BUSINESS_ID as string] : []);
        await resetConversation(handler);
        console.log(`🔀 Modo del agente: ${requested.toUpperCase()}\n`);
      } else {
        const active = isAgentV2Enabled(BUSINESS_ID as string) ? 'V2' : 'V1';
        console.log(`🔀 Modo actual: ${active}. Usá "/mode v1" o "/mode v2" para cambiarlo.\n`);
      }
      return;
    }

    if (!text) {
      return;
    }

    try {
      // Se llama al método privado directamente (sin el debounce de 1500ms que
      // usa el flujo real vía Baileys) para que la terminal responda al toque.
      // El debounce/batching de mensajes múltiples ya está cubierto por los
      // escenarios dm-01/dm-02 en el test suite.
      await (handler as unknown as { _processMessage: (m: BaileysMessage) => Promise<void> })._processMessage(
        buildMessage(text)
      );
    } catch (error) {
      console.error('💥 Error procesando el mensaje:', error);
    }
  }

  rl.on('line', (line) => {
    queue = queue.then(async () => {
      const result = await handleLine(line);
      if (result === 'exit') {
        rl.close();
        return;
      }
      rl.prompt();
    });
  });

  rl.on('close', async () => {
    await queue;
    console.log('\n👋 Chau!');
    process.exit(0);
  });
}

main().catch((error) => {
  console.error('💥 Error fatal:', error);
  process.exit(1);
});
