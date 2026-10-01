/**
 * Lista y levanta los silencios del bot en los locales de número compartido:
 * los chats que pidieron por la persona, y los chats en los que la persona
 * escribió desde el celular (ver `registerHumanReply` en
 * src/adaptations/shared-number.ts).
 *
 *   npx ts-node scripts/handoff-silences.ts list                  De La Fonte (como siempre)
 *   npx ts-node scripts/handoff-silences.ts remove <teléfono o conversationId>
 *   npx ts-node scripts/handoff-silences.ts antigal list          cualquier otro local, por id
 *   npx ts-node scripts/handoff-silences.ts antigal remove <teléfono o conversationId>
 *
 * Ids: delafonte, antigal, sky, lamision.
 *
 * De La Fonte (traspaso permanente) guarda sus silencios en el archivo local
 * de `handoff-store.ts`: la baja sólo agrega una línea y el historial queda.
 * Los demás viven en Redis con vencimiento y la baja borra la key. En los dos
 * casos el servidor en marcha lo toma en el siguiente mensaje: no hace falta
 * reiniciar.
 */
import * as dotenv from 'dotenv';
import { phoneCandidates } from '../src/utils/phone';
import {
  listPermanentHandoffs,
  removePermanentHandoff,
} from '../src/adaptations/handoff-store';
import { RedisConfig } from '../src/config/redis';
import { antigalAdaptation } from '../src/adaptations/antigal';
import { deLaFonteAdaptation } from '../src/adaptations/de-la-fonte';
import { laMisionAdaptation } from '../src/adaptations/la-mision';
import { skyAdaptation } from '../src/adaptations/sky';
import type { SharedNumberAdaptation } from '../src/adaptations';

dotenv.config();

const ADAPTATIONS: SharedNumberAdaptation[] = [
  deLaFonteAdaptation,
  antigalAdaptation,
  skyAdaptation,
  laMisionAdaptation,
];

/** Por qué está callado el bot en ese chat, tal como lo guarda el motor. */
const KINDS = {
  handoff: 'pidió por la persona',
  human: 'escribió la persona',
} as const;

interface Silence {
  conversationId: string;
  kind: string;
  /** Segundos que le quedan; null si no vence. */
  ttlSeconds: number | null;
  remove(): Promise<boolean>;
}

/** El teléfono es lo que va después del último guion del conversationId. */
function phoneOf(conversationId: string): string {
  return conversationId.slice(conversationId.lastIndexOf('-') + 1);
}

async function permanentSilences(adaptation: SharedNumberAdaptation): Promise<Silence[]> {
  const ids = await listPermanentHandoffs(adaptation.id);
  return ids.map((conversationId) => ({
    conversationId,
    kind: 'permanente',
    ttlSeconds: null,
    remove: () => removePermanentHandoff(adaptation.id, conversationId),
  }));
}

async function redisSilences(adaptation: SharedNumberAdaptation): Promise<Silence[]> {
  await RedisConfig.initialize(process.env.REDIS_URL || 'redis://localhost:6379');
  const client = RedisConfig.getClient();
  const silences: Silence[] = [];

  for (const [kind, label] of Object.entries(KINDS)) {
    const prefix = `adaptation:${adaptation.id}:${kind}:`;
    for await (const batch of client.scanIterator({ MATCH: `${prefix}*`, COUNT: 500 })) {
      for (const key of batch as string[]) {
        silences.push({
          conversationId: key.slice(prefix.length),
          kind: label,
          ttlSeconds: await client.ttl(key),
          remove: async () => (await client.del(key)) > 0,
        });
      }
    }
  }

  return silences.sort((a, b) => a.conversationId.localeCompare(b.conversationId));
}

function describeTtl(seconds: number | null): string {
  if (seconds === null || seconds < 0) return 'sin vencimiento';
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  return days > 0 ? `vence en ${days}d ${hours}h` : `vence en ${hours}h`;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const adaptation = ADAPTATIONS.find((a) => a.id === args[0]) ?? deLaFonteAdaptation;
  const [command, target] = adaptation.id === args[0] ? args.slice(1) : args;

  const silences = adaptation.permanentHandoff
    ? await permanentSilences(adaptation)
    : await redisSilences(adaptation);

  if (command === 'list') {
    if (silences.length === 0) console.log(`No hay chats silenciados en ${adaptation.id}.`);
    for (const s of silences) {
      console.log(`${s.conversationId}  ${s.kind}  ${describeTtl(s.ttlSeconds)}`);
    }
    return;
  }

  if (command === 'remove' && target) {
    // Acepta el conversationId entero o sólo el teléfono, con cualquier
    // formato (con/sin +, espacios, o el 9 móvil argentino).
    const candidates = new Set(phoneCandidates(target));
    const matches = silences.filter(
      (s) =>
        s.conversationId === target ||
        phoneCandidates(phoneOf(s.conversationId)).some((p) => candidates.has(p))
    );

    if (matches.length === 0) {
      console.error(`❌ No hay ningún chat silenciado en ${adaptation.id} que coincida con "${target}".`);
      process.exitCode = 1;
      return;
    }

    for (const silence of matches) {
      const done = await silence.remove();
      console.log(
        done
          ? `✅ Silencio levantado (${silence.kind}): ${silence.conversationId}`
          : `⚠️ No se pudo levantar: ${silence.conversationId}`
      );
      if (!done) process.exitCode = 1;
    }
    return;
  }

  console.error(
    'Uso: handoff-silences.ts [delafonte|antigal|sky|lamision] list | remove <teléfono o conversationId>'
  );
  process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error('❌', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (RedisConfig.isReady()) await RedisConfig.disconnect();
  });
