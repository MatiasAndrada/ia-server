/**
 * Normalización de números de teléfono.
 *
 * Existe por evidencia concreta: los clientes que llegan por WhatsApp se
 * guardan a partir del JID, ya en dígitos (`5493764671898`), mientras que el
 * panel guarda lo que tipea el operador (`+54 376 467 1898`). Las dos
 * consecuencias medidas de esa diferencia fueron:
 *
 *   1. `sendMessage` colgaba 15s y moría por timeout, porque el JID armado a
 *      mano quedaba `54 376 467 1898@s.whatsapp.net` — con espacios adentro.
 *      La normalización previa sólo sacaba el `+` inicial.
 *   2. El mismo cliente terminaba duplicado en `customers`, porque la búsqueda
 *      es por igualdad exacta de `phone`.
 *
 * El formato canónico es el que ya tienen las filas nacidas de WhatsApp: sólo
 * dígitos, sin `+` ni separadores.
 */

/** Prefijo país de Argentina. */
const AR_COUNTRY_CODE = '54';

/**
 * WhatsApp direcciona los móviles argentinos como `549<área><número>`. Ningún
 * código de área argentino empieza con 9, así que el dígito es un marcador no
 * ambiguo: si está, es el prefijo de móvil; si no está, falta.
 */
const AR_MOBILE_MARKER = '9';

/**
 * Deja un teléfono en formato canónico: sólo dígitos.
 *
 * Acepta también un JID entero, para poder usarse indistintamente sobre un
 * `customers.phone` o sobre un `remoteJid` sin que el caller tenga que saber
 * cuál de los dos tiene en la mano.
 *
 * @example
 * normalizePhone('+54 376 467 1898')            // '543764671898'
 * normalizePhone('5493532401540:55@s.whatsapp.net') // '5493532401540'
 * normalizePhone('sin numero')                  // ''
 */
export function normalizePhone(raw: string | null | undefined): string {
  if (!raw) {
    return '';
  }

  // Tolera un JID completo (`<número>[:dispositivo]@<dominio>`).
  const withoutDomain = raw.split('@')[0] ?? raw;
  const withoutDevice = withoutDomain.split(':')[0] ?? withoutDomain;

  const digits = withoutDevice.replace(/\D/g, '');

  // `00` es el prefijo internacional escrito a la europea: equivale a un `+`.
  return digits.startsWith('00') ? digits.slice(2) : digits;
}

/**
 * Variantes plausibles del mismo número, en orden de preferencia, para probar
 * contra `onWhatsApp()`.
 *
 * La segunda variante existe sólo por Argentina: un número cargado a mano como
 * `+54 376 467 1898` no lleva el `9` que WhatsApp necesita, y sin probar
 * `5493764671898` no resuelve a ninguna cuenta.
 *
 * @example
 * phoneCandidates('+54 376 467 1898')  // ['543764671898', '5493764671898']
 * phoneCandidates('5493764671898')     // ['5493764671898', '543764671898']
 */
export function phoneCandidates(raw: string | null | undefined): string[] {
  const digits = normalizePhone(raw);
  if (!digits) {
    return [];
  }

  const candidates = [digits];

  if (digits.startsWith(AR_COUNTRY_CODE)) {
    const rest = digits.slice(AR_COUNTRY_CODE.length);
    candidates.push(
      rest.startsWith(AR_MOBILE_MARKER)
        ? `${AR_COUNTRY_CODE}${rest.slice(1)}`
        : `${AR_COUNTRY_CODE}${AR_MOBILE_MARKER}${rest}`
    );
  }

  return [...new Set(candidates)];
}
