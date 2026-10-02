/**
 * Lista, agrega y levanta los silencios del bot en los locales de número
 * compartido: los chats que pidieron por la persona, y los chats en los que la
 * persona escribió desde el celular (ver `registerHumanReply` en
 * src/adaptations/shared-number.ts). Guía completa: docs/SILENCIOS.md.
 *
 *   npx ts-node scripts/handoff-silences.ts list                       De La Fonte (como siempre)
 *   npx ts-node scripts/handoff-silences.ts add <teléfono>
 *   npx ts-node scripts/handoff-silences.ts remove <teléfono o conversationId>
 *   npx ts-node scripts/handoff-silences.ts antigal list               cualquier otro local, por id
 *   npx ts-node scripts/handoff-silences.ts antigal add <teléfono> [--horas N | --permanente]
 *   npx ts-node scripts/handoff-silences.ts antigal remove <teléfono o conversationId>
 *
 * Ids: delafonte, antigal, sky, lamision.
 *
 * Todos los silencios viven en el archivo local de `handoff-store.ts`: el alta
 * y la baja sólo agregan una línea, así que el historial queda. Los silencios
 * de Antigal, SKY y La Misión anteriores a ese archivo pueden estar todavía
 * sólo en Redis hasta que vencen; `list` y `remove` también los ven. En todos
 * los casos el servidor en marcha lo toma en el siguiente mensaje: no hace
 * falta reiniciar.
 */
import * as dotenv from 'dotenv';
import { phoneCandidates } from '../src/utils/phone';
import {
  listSilences,
  removeSilence,
  saveSilence,
  type SilenceKind,
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

/** Lo que dura un silencio agregado a mano si no se dice otra cosa: lo mismo que un traspaso. */
const DEFAULT_HOURS = 48;

/** Por qué está callado el bot en ese chat, tal como lo guarda el motor. */
const KIND_LABELS: Record<SilenceKind, string> = {
  handoff: 'pidió por la persona',
  human: 'escribió la persona',
};

const USAGE =
  'Uso: handoff-silences.ts [delafonte|antigal|sky|lamision] ' +
  'list | add <teléfono> [--horas N | --permanente] | remove <teléfono o conversationId>';

interface Entry {
  conversationId: string;
  kind: SilenceKind;
  /** null si no vence. */
  expiresAt: Date | null;
  /** Dónde está: el archivo, o sólo Redis (silencios anteriores al archivo). */
  source: 'archivo' | 'redis';
}

/** El teléfono es lo que va después del último guion del conversationId. */
function phoneOf(conversationId: string): string {
  return conversationId.slice(conversationId.lastIndexOf('-') + 1);
}

function businessIds(adaptation: SharedNumberAdaptation): string[] {
  return (process.env[adaptation.businessIdEnvVar] ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
}

/** Redis, si está: sólo hace falta para los silencios anteriores al archivo. */
async function redis(): Promise<ReturnType<typeof RedisConfig.getClient> | null> {
  try {
    if (!RedisConfig.isReady()) {
      await RedisConfig.initialize(process.env.REDIS_URL || 'redis://localhost:6379');
    }
    return RedisConfig.getClient();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`⚠️ Redis no responde (${reason}): se muestran sólo los silencios del archivo.`);
    return null;
  }
}

function redisKey(adaptation: SharedNumberAdaptation, kind: SilenceKind, conversationId: string): string {
  return `adaptation:${adaptation.id}:${kind}:${conversationId}`;
}

async function allSilences(adaptation: SharedNumberAdaptation): Promise<Entry[]> {
  const entries: Entry[] = (await listSilences(adaptation.id)).map((silence) => ({
    ...silence,
    source: 'archivo' as const,
  }));

  // De La Fonte nunca usó Redis para esto.
  if (!adaptation.permanentHandoff) {
    const client = await redis();
    if (client) {
      const known = new Set(entries.map((e) => `${e.kind}:${e.conversationId}`));
      for (const kind of Object.keys(KIND_LABELS) as SilenceKind[]) {
        const prefix = `adaptation:${adaptation.id}:${kind}:`;
        for await (const batch of client.scanIterator({ MATCH: `${prefix}*`, COUNT: 500 })) {
          for (const key of batch as string[]) {
            const conversationId = key.slice(prefix.length);
            if (known.has(`${kind}:${conversationId}`)) continue;
            const ttl = await client.ttl(key);
            entries.push({
              conversationId,
              kind,
              expiresAt: ttl >= 0 ? new Date(Date.now() + ttl * 1000) : null,
              source: 'redis',
            });
          }
        }
      }
    }
  }

  return entries.sort((a, b) => a.conversationId.localeCompare(b.conversationId));
}

function describeExpiry(expiresAt: Date | null): string {
  if (expiresAt === null) return 'sin vencimiento';
  const seconds = Math.max(0, Math.round((expiresAt.getTime() - Date.now()) / 1000));
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  return days > 0 ? `vence en ${days}d ${hours}h` : `vence en ${hours}h ${minutes}m`;
}

function label(adaptation: SharedNumberAdaptation, entry: Entry): string {
  const kind = adaptation.permanentHandoff ? 'permanente' : KIND_LABELS[entry.kind];
  return entry.source === 'redis' ? `${kind} (sólo en Redis)` : kind;
}

/** `--horas N` / `--permanente`; si no, lo de siempre para ese local. */
function parseDuration(adaptation: SharedNumberAdaptation, flags: string[]): Date | null | 'invalid' {
  // En De La Fonte todo silencio es permanente: es la regla del local.
  if (adaptation.permanentHandoff || flags.includes('--permanente')) return null;

  const hoursFlag = flags.indexOf('--horas');
  const hours = hoursFlag >= 0 ? Number(flags[hoursFlag + 1]) : DEFAULT_HOURS;
  if (!Number.isFinite(hours) || hours <= 0) return 'invalid';
  return new Date(Date.now() + hours * 60 * 60 * 1000);
}

async function add(adaptation: SharedNumberAdaptation, target: string, flags: string[]): Promise<void> {
  const ids = businessIds(adaptation);
  if (ids.length === 0) {
    console.error(`❌ No está configurado el comercio de ${adaptation.id} (${adaptation.businessIdEnvVar} en .env).`);
    process.exitCode = 1;
    return;
  }

  // Las dos variantes del número (con y sin el 9 móvil argentino): el chat
  // queda identificado como lo haya escrito WhatsApp, y un silencio con la
  // otra variante no lo encontraría nunca.
  const phones = phoneCandidates(target);
  if (phones.length === 0) {
    console.error(`❌ "${target}" no es un teléfono.`);
    process.exitCode = 1;
    return;
  }

  const expiresAt = parseDuration(adaptation, flags);
  if (expiresAt === 'invalid') {
    console.error('❌ --horas tiene que ser un número mayor que cero.');
    process.exitCode = 1;
    return;
  }

  for (const businessId of ids) {
    for (const phone of phones) {
      const conversationId = `${businessId}-${phone}`;
      const written = await saveSilence(adaptation.id, conversationId, { expiresAt });
      console.log(
        written
          ? `✅ Silenciado (${describeExpiry(expiresAt)}): ${conversationId}`
          : `⚠️ Rige, pero no se pudo escribir en el archivo (se reintenta en el servidor): ${conversationId}`
      );
      if (!written) process.exitCode = 1;
    }
  }
}

async function remove(adaptation: SharedNumberAdaptation, target: string): Promise<void> {
  // Acepta el conversationId entero o sólo el teléfono, con cualquier
  // formato (con/sin +, espacios, o el 9 móvil argentino).
  const candidates = new Set(phoneCandidates(target));
  const matches = (await allSilences(adaptation)).filter(
    (entry) =>
      entry.conversationId === target ||
      phoneCandidates(phoneOf(entry.conversationId)).some((p) => candidates.has(p))
  );

  if (matches.length === 0) {
    console.error(`❌ No hay ningún chat silenciado en ${adaptation.id} que coincida con "${target}".`);
    process.exitCode = 1;
    return;
  }

  const client = adaptation.permanentHandoff ? null : await redis();
  for (const entry of matches) {
    const done = await removeSilence(adaptation.id, entry.conversationId, entry.kind);
    // La copia de Redis también, o el silencio seguiría hasta que venza.
    if (client) await client.del(redisKey(adaptation, entry.kind, entry.conversationId));
    console.log(
      done
        ? `✅ Silencio levantado (${label(adaptation, entry)}): ${entry.conversationId}`
        : `⚠️ No se pudo escribir la baja en el archivo: ${entry.conversationId}`
    );
    if (!done) process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const adaptation = ADAPTATIONS.find((a) => a.id === args[0]) ?? deLaFonteAdaptation;
  const [command, target, ...flags] = adaptation.id === args[0] ? args.slice(1) : args;

  if (command === 'list') {
    const silences = await allSilences(adaptation);
    if (silences.length === 0) console.log(`No hay chats silenciados en ${adaptation.id}.`);
    for (const s of silences) {
      console.log(`${s.conversationId}  ${label(adaptation, s)}  ${describeExpiry(s.expiresAt)}`);
    }
    return;
  }

  if (command === 'add' && target) {
    await add(adaptation, target, flags);
    return;
  }

  if (command === 'remove' && target) {
    await remove(adaptation, target);
    return;
  }

  console.error(USAGE);
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
