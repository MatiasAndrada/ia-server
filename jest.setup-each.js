/**
 * Cada test arranca con un archivo de silencios propio y vacío (ver
 * jest.setup.js): un chat silenciado en un test no puede seguir silenciado en
 * el siguiente. Los tests que necesitan una ruta puntual la pisan en su propio
 * `beforeEach`, que corre después de este.
 */
const os = require('node:os');
const path = require('node:path');

let counter = 0;

beforeEach(() => {
  counter += 1;
  process.env.SHARED_NUMBER_HANDOFF_FILE = path.join(
    os.tmpdir(),
    `ia-server-jest-handoffs-${process.pid}-${Date.now()}-${counter}.jsonl`
  );
});
