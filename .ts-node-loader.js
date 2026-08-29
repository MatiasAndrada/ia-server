/**
 * Mapea imports `./foo.js` a `./foo.ts` cuando se corre con ts-node.
 *
 * El código fuente usa extensión `.js` en los imports relativos porque el
 * tsconfig está en `module: NodeNext`, que lo exige. Al compilar (`tsc`) eso
 * queda bien, porque en `dist/` los `.js` existen de verdad. Pero ts-node
 * resuelve en CJS contra `src/`, donde esos archivos son `.ts`, y falla con
 * "Cannot find module './config/openrouter.js'".
 *
 * ⚠️ Este archivo está declarado en `tsconfig.json` bajo `ts-node.require`,
 * PERO ts-node-dev no lee esa opción: hay que pasarlo explícito con
 * `-r ./.ts-node-loader.js` en el script `dev` de package.json. Sin ese flag,
 * `pnpm dev` no arranca. El tsconfig se deja igual porque sí lo toman los
 * `ts-node` directos (scripts/, `pnpm chat:simulate`, `pnpm eval`).
 */
const Module = require('module');
const path = require('path');
const fs = require('fs');

const originalResolveFilename = Module._resolveFilename;

Module._resolveFilename = function(request, parent, isMain) {
  // If the request ends with .js and it's a relative path
  if (request.endsWith('.js') && (request.startsWith('.') || request.startsWith('/'))) {
    // Try to find the .ts version
    const tsRequest = request.slice(0, -3) + '.ts';
    try {
      const resolved = originalResolveFilename.call(this, tsRequest, parent, isMain);
      if (fs.existsSync(resolved)) {
        return resolved;
      }
    } catch (e) {
      // Fall through to original resolution
    }
  }

  return originalResolveFilename.call(this, request, parent, isMain);
};

module.exports = {};
