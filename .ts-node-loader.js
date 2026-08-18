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
