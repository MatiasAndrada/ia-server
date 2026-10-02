/**
 * Corre antes de cada archivo de tests.
 *
 * Los tests se ejecutan en el mismo directorio que producción, y el archivo de
 * silencios por defecto (`data/shared-number-handoffs.jsonl`) es el REAL: un
 * test que silenciara un chat sin configurar su propia ruta escribiría ahí.
 * Cada archivo de tests arranca con una ruta temporal propia; los que la
 * necesitan controlar la siguen pisando en su `beforeEach`.
 */
const os = require('node:os');
const path = require('node:path');

process.env.SHARED_NUMBER_HANDOFF_FILE = path.join(
  os.tmpdir(),
  `ia-server-jest-handoffs-${process.pid}-${Date.now()}.jsonl`
);
