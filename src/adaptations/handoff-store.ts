import { promises as fs } from 'node:fs';
import path from 'node:path';
import { logger } from '../utils/logger.js';

/**
 * Persistencia local de los silencios del bot en los locales de número
 * compartido: los traspasos permanentes (`permanentHandoff`) y también los que
 * vencen (cuarenta y ocho horas en Antigal, SKY y La Misión).
 *
 * Es la fuente de verdad del "el bot no habla en este chat": vive en un archivo
 * del servidor, así que un reinicio o un flush de Redis no reactiva a nadie.
 * Antes los silencios que vencen vivían sólo en Redis, y un reinicio de Redis
 * devolvía el bot a chats que el cliente le había pasado a la persona. Tampoco
 * depende de Supabase.
 *
 * Formato: un JSON por línea, sólo se agrega al final (nunca se reescribe).
 *   alta: {"a":"delafonte","c":"<conversationId>","t":"<ISO>"}
 *   alta que vence: {"a":"antigal","c":"<conversationId>","t":"<ISO>","e":"<ISO>"}
 *   la persona escribió: {"a":"antigal","c":"<conversationId>","t":"<ISO>","k":"human","e":"<ISO>"}
 *   baja: {"a":"delafonte","c":"<conversationId>","t":"<ISO>","r":true}
 * Sin `k` es el traspaso (el cliente pidió por la persona); sin `e` no vence.
 * Las líneas anteriores a estos campos son traspasos permanentes y se leen
 * igual que siempre. El estado de un silencio es el de su última línea. Como
 * sólo se agrega, una escritura cortada por un crash daña a lo sumo la última
 * línea (que se saltea al cargar), y queda el historial de quién se silenció y
 * cuándo se levantó.
 *
 * Resiliencia:
 * - Si una escritura falla (disco lleno, permisos), el cambio rige igual en
 *   memoria y queda como PENDIENTE: se reintenta en la próxima operación, como
 *   mucho cada `RETRY_INTERVAL_MS`, hasta que entre al disco.
 * - Si el archivo cambia por fuera del proceso (por ejemplo con
 *   `scripts/handoff-silences.ts`), se detecta por su mtime/tamaño y se relee
 *   en el siguiente mensaje: agregar o levantar un silencio no requiere
 *   reiniciar.
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

/**
 * Un silencio que se renueva (la persona sigue escribiendo en el chat) sólo se
 * vuelve a escribir si estira el vencimiento al menos esto. Sin el tope, cada
 * mensaje suyo agregaría una línea; con él, a lo sumo una por hora y por chat.
 */
const MIN_EXTENSION_MS = 60 * 60 * 1000;

/**
 * Qué silencio es: `handoff`, el cliente pidió por la persona (o el modelo
 * derivó el chat); `human`, la persona escribió en el chat desde el celular.
 */
export type SilenceKind = 'handoff' | 'human';

interface HandoffRecord {
  a: string; // adaptation id
  c: string; // conversation id
  t: string; // ISO timestamp
  k?: 'human'; // sin `k`: el traspaso
  e?: string; // ISO: cuándo vence; sin `e`, no vence
  r?: true; // baja: se levanta el silencio
}

/** Un silencio vigente, como lo ve quien lista. */
export interface Silence {
  conversationId: string;
  kind: SilenceKind;
  /** `null` si no vence. */
  expiresAt: Date | null;
}

interface FileStamp {
  mtimeMs: number;
  size: number;
}

function filePath(): string {
  return path.resolve(process.env[FILE_ENV_VAR]?.trim() || DEFAULT_FILE);
}

function kindOf(record: Pick<HandoffRecord, 'k'>): SilenceKind {
  return record.k === 'human' ? 'human' : 'handoff';
}

function keyOf(adaptationId: string, kind: SilenceKind, conversationId: string): string {
  return `${adaptationId}:${kind}:${conversationId}`;
}

/** Vencimiento en ms de cada silencio registrado; `null` si no vence. */
type Entries = Map<string, number | null>;

function apply(entries: Entries, record: HandoffRecord): void {
  const key = keyOf(record.a, kindOf(record), record.c);
  if (record.r) {
    entries.delete(key);
    return;
  }
  const expiresAt = record.e ? Date.parse(record.e) : null;
  entries.set(key, Number.isNaN(expiresAt) ? null : expiresAt);
}

function isActive(entries: Entries, key: string, now = Date.now()): boolean {
  if (!entries.has(key)) return false;
  const expiresAt = entries.get(key)!;
  return expiresAt === null || expiresAt > now;
}

// Estado del proceso. Todas las operaciones públicas pasan por `serialized`,
// así que nunca hay dos leyendo/escribiendo el estado a la vez.
let entries: Entries = new Map();
/** Cambios que rigen en memoria pero todavía no están en el disco, en orden. */
let pending: HandoffRecord[] = [];
let stamp: FileStamp | null = null;
/** El archivo del que sale `entries`. Si la ruta cambia (sólo en tests), se relee. */
let loadedFile: string | null = null;
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

  const fresh: Entries = new Map();
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
  if (!initialized || file !== loadedFile || !sameStamp(current, stamp)) {
    await readFromDisk(file);
    stamp = current;
    loadedFile = file;
    initialized = true;
  }

  if (pending.length > 0 && Date.now() - lastRetryAt >= RETRY_INTERVAL_MS) {
    await flushPending(file);
  }
}

/** ¿Hay un silencio vigente de este tipo para esta conversación? Nunca lanza. */
export function hasSilence(
  adaptationId: string,
  conversationId: string,
  kind: SilenceKind = 'handoff'
): Promise<boolean> {
  return serialized(async () => {
    await refresh();
    return isActive(entries, keyOf(adaptationId, kind, conversationId));
  });
}

/**
 * Registra un silencio, sin vencimiento si `expiresAt` es `null`. Devuelve si
 * quedó escrito en disco.
 *
 * Idempotente: no escribe si ya hay uno vigente que dura lo mismo o más (ver
 * `MIN_EXTENSION_MS`). Un silencio permanente nunca se acorta. Rige en memoria
 * aunque el disco falle: en ese caso queda pendiente y se reintenta solo (ver
 * arriba), y el error queda en el log.
 */
export function saveSilence(
  adaptationId: string,
  conversationId: string,
  { kind = 'handoff', expiresAt = null }: { kind?: SilenceKind; expiresAt?: Date | null } = {}
): Promise<boolean> {
  return serialized(async () => {
    await refresh();

    const key = keyOf(adaptationId, kind, conversationId);
    if (isActive(entries, key)) {
      const current = entries.get(key)!;
      const extends_ =
        current !== null &&
        (expiresAt === null || expiresAt.getTime() - current >= MIN_EXTENSION_MS);
      if (!extends_) return pending.length === 0; // ya estaba así
    }

    return change({
      a: adaptationId,
      c: conversationId,
      t: new Date().toISOString(),
      ...(kind === 'human' && { k: 'human' as const }),
      ...(expiresAt && { e: expiresAt.toISOString() }),
    });
  });
}

/**
 * Levanta un silencio: el bot vuelve a atender esa conversación. Devuelve si
 * la baja quedó escrita en disco (si no, queda pendiente igual que un alta).
 */
export function removeSilence(
  adaptationId: string,
  conversationId: string,
  kind: SilenceKind = 'handoff'
): Promise<boolean> {
  return serialized(async () => {
    await refresh();
    // Dar de baja algo que no está registrado no escribe nada.
    if (!entries.has(keyOf(adaptationId, kind, conversationId))) return pending.length === 0;

    return change({
      a: adaptationId,
      c: conversationId,
      t: new Date().toISOString(),
      ...(kind === 'human' && { k: 'human' as const }),
      r: true,
    });
  });
}

/** Silencios vigentes de una adaptación, para listarlos o buscarlos. */
export function listSilences(adaptationId: string): Promise<Silence[]> {
  return serialized(async () => {
    await refresh();
    const now = Date.now();
    const silences: Silence[] = [];
    for (const [key, expiresAt] of entries) {
      if (!isActive(entries, key, now)) continue;
      const [a, kind, ...rest] = key.split(':');
      if (a !== adaptationId) continue;
      silences.push({
        conversationId: rest.join(':'),
        kind: kind as SilenceKind,
        expiresAt: expiresAt === null ? null : new Date(expiresAt),
      });
    }
    return silences.sort((x, y) => x.conversationId.localeCompare(y.conversationId));
  });
}

/** Aplica un cambio en memoria y lo escribe. Se llama ya dentro de `serialized`. */
async function change(record: HandoffRecord): Promise<boolean> {
  apply(entries, record);
  pending.push(record);
  return flushPending(filePath());
}

// ─── Traspasos permanentes (De La Fonte) ───
// Los nombres de siempre, sobre el mismo registro.

/** ¿Hay un traspaso registrado para esta conversación? Nunca lanza. */
export function hasPermanentHandoff(adaptationId: string, conversationId: string): Promise<boolean> {
  return hasSilence(adaptationId, conversationId);
}

/** Registra el traspaso, sin vencimiento. Idempotente. Devuelve si quedó escrito en disco. */
export function savePermanentHandoff(adaptationId: string, conversationId: string): Promise<boolean> {
  return saveSilence(adaptationId, conversationId);
}

/** Levanta el traspaso: el bot vuelve a atender esa conversación. */
export function removePermanentHandoff(adaptationId: string, conversationId: string): Promise<boolean> {
  return removeSilence(adaptationId, conversationId);
}

/** Conversaciones con traspaso vigente de una adaptación. */
export async function listPermanentHandoffs(adaptationId: string): Promise<string[]> {
  return (await listSilences(adaptationId))
    .filter((silence) => silence.kind === 'handoff')
    .map((silence) => silence.conversationId);
}

/** Sólo para tests: descarta todo el estado en memoria. */
export function resetHandoffStoreForTests(): void {
  entries = new Map();
  pending = [];
  stamp = null;
  loadedFile = null;
  initialized = false;
  lastRetryAt = 0;
  needsLeadingNewline = false;
  queue = Promise.resolve();
}

/** Sólo para tests: cuántos cambios siguen sin estar en el disco. */
export function pendingHandoffChangesForTests(): number {
  return pending.length;
}
