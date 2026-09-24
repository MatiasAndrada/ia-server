import { promises as fs } from 'node:fs';
import path from 'node:path';
import { logger } from '../utils/logger.js';

/**
 * Persistencia local de los traspasos permanentes (`permanentHandoff`).
 *
 * Es la fuente de verdad del "el bot no vuelve nunca más en este chat": vive en
 * un archivo del servidor, no en Redis, así que un reinicio o un flush de Redis
 * no reactiva a nadie. Tampoco depende de Supabase.
 *
 * Formato: un JSON por línea, sólo se agrega al final (nunca se reescribe).
 *   alta: {"a":"delafonte","c":"<conversationId>","t":"<ISO>"}
 *   baja: {"a":"delafonte","c":"<conversationId>","t":"<ISO>","r":true}
 * El estado de un chat es el de su última línea. Como sólo se agrega, una
 * escritura cortada por un crash daña a lo sumo la última línea (que se saltea
 * al cargar), y queda el historial de quién se silenció y cuándo se levantó.
 *
 * Resiliencia:
 * - Si una escritura falla (disco lleno, permisos), el cambio rige igual en
 *   memoria y queda como PENDIENTE: se reintenta en la próxima operación, como
 *   mucho cada `RETRY_INTERVAL_MS`, hasta que entre al disco.
 * - Si el archivo cambia por fuera del proceso (por ejemplo con
 *   `scripts/handoff-silences.ts`), se detecta por su mtime/tamaño y se relee
 *   en el siguiente mensaje: levantar un silencio no requiere reiniciar.
 *
 * Supuesto: un solo proceso escribe el archivo (PM2 en modo `fork`, una
 * instancia — ver `ecosystem.config.js`).
 *
 * Ruta por defecto `data/shared-number-handoffs.jsonl` respecto del directorio
 * de trabajo, como `auth_sessions`; se cambia con `SHARED_NUMBER_HANDOFF_FILE`.
 * Está en `.gitignore`, así que `git pull` en el deploy no lo toca.
 */
const FILE_ENV_VAR = 'SHARED_NUMBER_HANDOFF_FILE';
const DEFAULT_FILE = path.join('data', 'shared-number-handoffs.jsonl');

/** Cada cuánto, como mínimo, se reintenta escribir lo pendiente. */
const RETRY_INTERVAL_MS = 30_000;

interface HandoffRecord {
  a: string; // adaptation id
  c: string; // conversation id
  t: string; // ISO timestamp
  r?: true; // baja: se levanta el silencio
}

interface FileStamp {
  mtimeMs: number;
  size: number;
}

function filePath(): string {
  return path.resolve(process.env[FILE_ENV_VAR]?.trim() || DEFAULT_FILE);
}

function keyOf(adaptationId: string, conversationId: string): string {
  return `${adaptationId}:${conversationId}`;
}

function apply(entries: Set<string>, record: HandoffRecord): void {
  const key = keyOf(record.a, record.c);
  if (record.r) entries.delete(key);
  else entries.add(key);
}

// Estado del proceso. Todas las operaciones públicas pasan por `serialized`,
// así que nunca hay dos leyendo/escribiendo el estado a la vez.
let entries = new Set<string>();
/** Cambios que rigen en memoria pero todavía no están en el disco, en orden. */
let pending: HandoffRecord[] = [];
let stamp: FileStamp | null = null;
let initialized = false;
let lastRetryAt = 0;
/**
 * El archivo terminó sin `\n` (una escritura cortada por un crash): la próxima
 * línea necesita un salto previo, o se pega a la cortada y se pierde.
 */
let needsLeadingNewline = false;
let queue: Promise<unknown> = Promise.resolve();

function serialized<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.catch(() => undefined);
  return run;
}

async function statFile(file: string): Promise<FileStamp | null> {
  try {
    const { mtimeMs, size } = await fs.stat(file);
    return { mtimeMs, size };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.error('Failed to stat the handoff file', {
        file,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
    return null;
  }
}

function sameStamp(a: FileStamp | null, b: FileStamp | null): boolean {
  return a === b || (a !== null && b !== null && a.mtimeMs === b.mtimeMs && a.size === b.size);
}

async function readFromDisk(file: string): Promise<void> {
  let raw = '';
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      // No se pudo leer: se conserva lo que ya hay en memoria en vez de
      // "olvidar" silencios por un error de lectura pasajero.
      logger.error('Failed to read the handoff file, keeping what is in memory', {
        file,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return;
    }
  }

  const fresh = new Set<string>();
  let skipped = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line) as Partial<HandoffRecord>;
      if (typeof record.a === 'string' && typeof record.c === 'string') {
        apply(fresh, record as HandoffRecord);
      } else {
        skipped++;
      }
    } catch {
      skipped++;
    }
  }
  if (skipped > 0) {
    logger.warn('Skipped unreadable lines in the handoff file', { file, skipped });
  }

  // Lo pendiente todavía no está en el archivo: se vuelve a aplicar encima.
  for (const record of pending) apply(fresh, record);

  entries = fresh;
  needsLeadingNewline = raw.length > 0 && !raw.endsWith('\n');
}

/** Intenta escribir lo pendiente. Devuelve si no queda nada sin escribir. */
async function flushPending(file: string): Promise<boolean> {
  if (pending.length === 0) return true;
  lastRetryAt = Date.now();

  const lines = pending.map((record) => JSON.stringify(record)).join('\n');
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.appendFile(file, `${needsLeadingNewline ? '\n' : ''}${lines}\n`, 'utf8');
    needsLeadingNewline = false;
    pending = [];
    // Lo que se acaba de escribir es propio: se registra el nuevo estado del
    // archivo para no releerlo como si lo hubiera cambiado otro.
    stamp = await statFile(file);
    return true;
  } catch (error) {
    logger.error('Failed to write the handoff file, changes stay pending and will be retried', {
      file,
      pendingChanges: pending.length,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    return false;
  }
}

/** Deja el estado en memoria al día: relee si el archivo cambió y reintenta lo pendiente. */
async function refresh(): Promise<void> {
  const file = filePath();

  const current = await statFile(file);
  if (!initialized || !sameStamp(current, stamp)) {
    await readFromDisk(file);
    stamp = current;
    initialized = true;
  }

  if (pending.length > 0 && Date.now() - lastRetryAt >= RETRY_INTERVAL_MS) {
    await flushPending(file);
  }
}

/** ¿Hay un traspaso permanente registrado para esta conversación? Nunca lanza. */
export function hasPermanentHandoff(
  adaptationId: string,
  conversationId: string
): Promise<boolean> {
  return serialized(async () => {
    await refresh();
    return entries.has(keyOf(adaptationId, conversationId));
  });
}

/**
 * Registra el traspaso. Idempotente. Devuelve si quedó escrito en disco.
 *
 * Rige en memoria aunque el disco falle: en ese caso queda pendiente y se
 * reintenta solo (ver arriba), y el error queda en el log.
 */
export function savePermanentHandoff(
  adaptationId: string,
  conversationId: string
): Promise<boolean> {
  return change({ a: adaptationId, c: conversationId, t: new Date().toISOString() });
}

/**
 * Levanta el silencio de una conversación: el bot vuelve a atenderla. Devuelve
 * si la baja quedó escrita en disco (si no, queda pendiente igual que un alta).
 */
export function removePermanentHandoff(
  adaptationId: string,
  conversationId: string
): Promise<boolean> {
  return change({ a: adaptationId, c: conversationId, t: new Date().toISOString(), r: true });
}

function change(record: HandoffRecord): Promise<boolean> {
  return serialized(async () => {
    await refresh();

    const before = entries.has(keyOf(record.a, record.c));
    if (before === !record.r) return pending.length === 0; // ya estaba así

    apply(entries, record);
    pending.push(record);
    return flushPending(filePath());
  });
}

/** Conversaciones silenciadas de una adaptación, para listarlas o buscarlas. */
export function listPermanentHandoffs(adaptationId: string): Promise<string[]> {
  return serialized(async () => {
    await refresh();
    const prefix = `${adaptationId}:`;
    return [...entries]
      .filter((key) => key.startsWith(prefix))
      .map((key) => key.slice(prefix.length))
      .sort();
  });
}

/** Sólo para tests: descarta todo el estado en memoria. */
export function resetHandoffStoreForTests(): void {
  entries = new Set();
  pending = [];
  stamp = null;
  initialized = false;
  lastRetryAt = 0;
  needsLeadingNewline = false;
  queue = Promise.resolve();
}

/** Sólo para tests: cuántos cambios siguen sin estar en el disco. */
export function pendingHandoffChangesForTests(): number {
  return pending.length;
}
