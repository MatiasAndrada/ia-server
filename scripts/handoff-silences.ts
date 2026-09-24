/**
 * Lista y levanta los silencios permanentes de De La Fonte (los chats que
 * eligieron "Simona"), guardados en el archivo local de `handoff-store.ts`.
 *
 *   npx ts-node scripts/handoff-silences.ts list
 *   npx ts-node scripts/handoff-silences.ts remove <teléfono o conversationId>
 *
 * El servidor en marcha detecta el cambio del archivo en el siguiente mensaje:
 * no hace falta reiniciar. Sólo agrega una línea de baja; el historial queda.
 */
import * as dotenv from 'dotenv';
import { phoneCandidates } from '../src/utils/phone';
import {
  listPermanentHandoffs,
  removePermanentHandoff,
} from '../src/adaptations/handoff-store';
import { deLaFonteAdaptation } from '../src/adaptations/de-la-fonte';

dotenv.config();

const ADAPTATION_ID = deLaFonteAdaptation.id;

/** El teléfono es lo que va después del último guion del conversationId. */
function phoneOf(conversationId: string): string {
  return conversationId.slice(conversationId.lastIndexOf('-') + 1);
}

async function main(): Promise<void> {
  const [command, target] = process.argv.slice(2);
  const silenced = await listPermanentHandoffs(ADAPTATION_ID);

  if (command === 'list') {
    if (silenced.length === 0) console.log('No hay chats silenciados.');
    for (const conversationId of silenced) console.log(conversationId);
    return;
  }

  if (command === 'remove' && target) {
    // Acepta el conversationId entero o sólo el teléfono, con cualquier
    // formato (con/sin +, espacios, o el 9 móvil argentino).
    const candidates = new Set(phoneCandidates(target));
    const matches = silenced.filter(
      (id) => id === target || phoneCandidates(phoneOf(id)).some((p) => candidates.has(p))
    );

    if (matches.length === 0) {
      console.error(`❌ No hay ningún chat silenciado que coincida con "${target}".`);
      process.exitCode = 1;
      return;
    }

    for (const conversationId of matches) {
      const written = await removePermanentHandoff(ADAPTATION_ID, conversationId);
      console.log(
        written
          ? `✅ Silencio levantado: ${conversationId}`
          : `⚠️ No se pudo escribir la baja en disco: ${conversationId}`
      );
      if (!written) process.exitCode = 1;
    }
    return;
  }

  console.error('Uso: handoff-silences.ts list | remove <teléfono o conversationId>');
  process.exitCode = 1;
}

main().catch((error) => {
  console.error('❌', error);
  process.exit(1);
});
