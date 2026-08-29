/**
 * Carga de entorno para desarrollo, en capas.
 *
 * Existe porque la instancia de dev y la de producción corren desde el MISMO
 * directorio en este host, así que comparten `.env`. Poner ahí las variables de
 * aislamiento (directorio de credenciales, puerto, lista de negocios
 * permitidos) se las aplicaría también a producción, que es justo lo que hay
 * que evitar.
 *
 * Orden: primero `.env` (config común y secretos), después `.env.dev` con
 * `override: true` para lo que dev necesita distinto. Se precarga con `-r`
 * ANTES de que arranque el server; el `import 'dotenv/config'` que hace
 * src/index.ts no pisa nada, porque dotenv no sobreescribe variables ya
 * definidas en process.env.
 *
 * Producción no usa este archivo: PM2 corre `dist/index.js`, que sólo lee `.env`.
 */
const dotenv = require('dotenv');

dotenv.config();
dotenv.config({ path: '.env.dev', override: true });
