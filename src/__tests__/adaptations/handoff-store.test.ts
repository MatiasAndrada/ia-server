import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  hasPermanentHandoff,
  listPermanentHandoffs,
  pendingHandoffChangesForTests,
  removePermanentHandoff,
  resetHandoffStoreForTests,
  savePermanentHandoff,
} from '../../adaptations/handoff-store.js';

jest.mock('../../utils/logger');

/**
 * El archivo local es la fuente de verdad del "nunca más" de De La Fonte. Lo que
 * importa: sobrevive a un reinicio, tolera una escritura cortada y nunca lanza.
 */
describe('handoff-store', () => {
  let file: string;

  beforeEach(async () => {
    jest.restoreAllMocks();
    resetHandoffStoreForTests();
    file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'handoff-store-')), 'h.jsonl');
    process.env.SHARED_NUMBER_HANDOFF_FILE = file;
  });

  afterAll(() => {
    delete process.env.SHARED_NUMBER_HANDOFF_FILE;
  });

  it('sin archivo no hay traspasos', async () => {
    expect(await hasPermanentHandoff('delafonte', 'c1')).toBe(false);
  });

  it('lo guardado se recuerda, y sólo para esa adaptación y conversación', async () => {
    expect(await savePermanentHandoff('delafonte', 'c1')).toBe(true);

    expect(await hasPermanentHandoff('delafonte', 'c1')).toBe(true);
    expect(await hasPermanentHandoff('delafonte', 'c2')).toBe(false);
    expect(await hasPermanentHandoff('sky', 'c1')).toBe(false);
  });

  it('sobrevive a un reinicio: se relee del archivo', async () => {
    await savePermanentHandoff('delafonte', 'c1');
    await savePermanentHandoff('delafonte', 'c2');
    resetHandoffStoreForTests();

    expect(await hasPermanentHandoff('delafonte', 'c1')).toBe(true);
    expect(await hasPermanentHandoff('delafonte', 'c2')).toBe(true);
  });

  it('es idempotente: no repite líneas', async () => {
    await savePermanentHandoff('delafonte', 'c1');
    await savePermanentHandoff('delafonte', 'c1');

    expect((await fs.readFile(file, 'utf8')).trim().split('\n')).toHaveLength(1);
  });

  it('una línea cortada por un crash no pierde las anteriores', async () => {
    await savePermanentHandoff('delafonte', 'c1');
    await fs.appendFile(file, '{"a":"delafonte","c":"c2","t":"2026-09'); // sin cerrar ni \n
    resetHandoffStoreForTests();

    expect(await hasPermanentHandoff('delafonte', 'c1')).toBe(true);
    expect(await hasPermanentHandoff('delafonte', 'c2')).toBe(false);
  });

  it('guardar después de una línea cortada no corrompe el registro nuevo', async () => {
    await fs.writeFile(file, '{"a":"delafonte","c":"c1"'); // última línea sin \n
    resetHandoffStoreForTests();

    await savePermanentHandoff('delafonte', 'c3');
    resetHandoffStoreForTests();

    expect(await hasPermanentHandoff('delafonte', 'c3')).toBe(true);
  });

  describe('si el disco falla al escribir', () => {
    it('devuelve false sin lanzar, y el silencio rige igual en memoria', async () => {
      jest.spyOn(fs, 'appendFile').mockRejectedValue(new Error('ENOSPC'));

      await expect(savePermanentHandoff('delafonte', 'c1')).resolves.toBe(false);

      expect(await hasPermanentHandoff('delafonte', 'c1')).toBe(true);
      expect(pendingHandoffChangesForTests()).toBe(1);
    });

    it('lo pendiente se reintenta solo, pasado el intervalo, y llega al disco', async () => {
      const append = jest.spyOn(fs, 'appendFile').mockRejectedValueOnce(new Error('ENOSPC'));
      await savePermanentHandoff('delafonte', 'c1');

      // Antes del intervalo no se reintenta en cada mensaje.
      await hasPermanentHandoff('delafonte', 'c1');
      expect(append).toHaveBeenCalledTimes(1);

      const now = Date.now();
      jest.spyOn(Date, 'now').mockReturnValue(now + 31_000);
      await hasPermanentHandoff('delafonte', 'c1');

      expect(pendingHandoffChangesForTests()).toBe(0);
      resetHandoffStoreForTests();
      expect(await hasPermanentHandoff('delafonte', 'c1')).toBe(true);
    });

    it('un nuevo cambio también intenta escribir lo pendiente, en orden', async () => {
      jest.spyOn(fs, 'appendFile').mockRejectedValueOnce(new Error('ENOSPC'));
      await savePermanentHandoff('delafonte', 'c1');

      expect(await savePermanentHandoff('delafonte', 'c2')).toBe(true);

      resetHandoffStoreForTests();
      expect(await listPermanentHandoffs('delafonte')).toEqual(['c1', 'c2']);
    });

    it('no pierde lo pendiente si el archivo se relee por un cambio externo', async () => {
      jest.spyOn(fs, 'appendFile').mockRejectedValue(new Error('ENOSPC'));
      await savePermanentHandoff('delafonte', 'c1');
      jest.restoreAllMocks();

      // Otro proceso (el script) escribe otra línea mientras c1 sigue pendiente.
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, '{"a":"delafonte","c":"c9","t":"x"}\n');

      expect(await hasPermanentHandoff('delafonte', 'c9')).toBe(true);
      expect(await hasPermanentHandoff('delafonte', 'c1')).toBe(true);
    });

    it('un error al leer no borra lo que ya estaba en memoria', async () => {
      await savePermanentHandoff('delafonte', 'c1');
      jest.spyOn(fs, 'readFile').mockRejectedValue(
        Object.assign(new Error('EIO'), { code: 'EIO' })
      );
      // Fuerza la relectura simulando que otro proceso tocó el archivo.
      await fs.appendFile(file, '{"a":"delafonte","c":"c2","t":"x"}\n');

      expect(await hasPermanentHandoff('delafonte', 'c1')).toBe(true);
    });
  });

  describe('levantar un silencio', () => {
    it('la baja hace que el bot vuelva a atender ese chat', async () => {
      await savePermanentHandoff('delafonte', 'c1');

      await removePermanentHandoff('delafonte', 'c1');

      expect(await hasPermanentHandoff('delafonte', 'c1')).toBe(false);
    });

    it('la baja sobrevive a un reinicio y no toca a los demás chats', async () => {
      await savePermanentHandoff('delafonte', 'c1');
      await savePermanentHandoff('delafonte', 'c2');
      await removePermanentHandoff('delafonte', 'c1');
      resetHandoffStoreForTests();

      expect(await hasPermanentHandoff('delafonte', 'c1')).toBe(false);
      expect(await hasPermanentHandoff('delafonte', 'c2')).toBe(true);
    });

    it('sólo agrega una línea: el historial del alta queda', async () => {
      await savePermanentHandoff('delafonte', 'c1');
      await removePermanentHandoff('delafonte', 'c1');

      const lines = (await fs.readFile(file, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
      expect(lines).toHaveLength(2);
      expect(lines[1]).toMatchObject({ c: 'c1', r: true });
    });

    it('un chat dado de baja puede volver a silenciarse', async () => {
      await savePermanentHandoff('delafonte', 'c1');
      await removePermanentHandoff('delafonte', 'c1');
      await savePermanentHandoff('delafonte', 'c1');
      resetHandoffStoreForTests();

      expect(await hasPermanentHandoff('delafonte', 'c1')).toBe(true);
    });

    it('sin reiniciar: una baja escrita por fuera (el script) se detecta sola', async () => {
      await savePermanentHandoff('delafonte', 'c1');
      expect(await hasPermanentHandoff('delafonte', 'c1')).toBe(true);

      await fs.appendFile(file, '{"a":"delafonte","c":"c1","t":"x","r":true}\n');

      expect(await hasPermanentHandoff('delafonte', 'c1')).toBe(false);
    });

    it('dar de baja un chat que no estaba silenciado no escribe nada', async () => {
      await removePermanentHandoff('delafonte', 'nunca-estuvo');

      await expect(fs.readFile(file, 'utf8')).rejects.toThrow();
    });
  });
});
