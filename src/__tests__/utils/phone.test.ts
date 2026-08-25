import { normalizePhone, phoneCandidates } from '../../utils/phone.js';

describe('normalizePhone', () => {
  it('strips the separators the dashboard writes', () => {
    // El caso real que rompía los envíos: el panel guarda lo que tipea el
    // operador, y `resolveJid` sólo sacaba el `+`, dejando los espacios dentro
    // del JID.
    expect(normalizePhone('+54 376 467 1898')).toBe('543764671898');
  });

  it('leaves an already canonical number untouched', () => {
    expect(normalizePhone('5493764671898')).toBe('5493764671898');
  });

  it('accepts a full JID, device suffix included', () => {
    expect(normalizePhone('5493532401540:55@s.whatsapp.net')).toBe('5493532401540');
    expect(normalizePhone('189489813160117@lid')).toBe('189489813160117');
  });

  it('treats a leading 00 as the international prefix', () => {
    expect(normalizePhone('005493764671898')).toBe('5493764671898');
  });

  it('handles the assorted ways a human writes a number', () => {
    expect(normalizePhone('(376) 467-1898')).toBe('3764671898');
    expect(normalizePhone(' 54.376.467.1898 ')).toBe('543764671898');
  });

  it('returns empty for input with no digits at all', () => {
    expect(normalizePhone('sin numero')).toBe('');
    expect(normalizePhone('')).toBe('');
    expect(normalizePhone(null)).toBe('');
    expect(normalizePhone(undefined)).toBe('');
  });
});

describe('phoneCandidates', () => {
  it('adds the Argentine mobile 9 when it is missing', () => {
    // WhatsApp direcciona los móviles argentinos como 549…, pero nadie escribe
    // ese 9 a mano. Sin la variante, el número del panel no resuelve a nadie.
    expect(phoneCandidates('+54 376 467 1898')).toEqual(['543764671898', '5493764671898']);
  });

  it('offers the variant without the 9 when the number already has it', () => {
    expect(phoneCandidates('5493764671898')).toEqual(['5493764671898', '543764671898']);
  });

  it('keeps the normalized number first, so the fallback JID stays sane', () => {
    expect(phoneCandidates('5493764671898')[0]).toBe('5493764671898');
  });

  it('does not invent variants for non-Argentine numbers', () => {
    expect(phoneCandidates('+55 45 99999 8888')).toEqual(['5545999998888']);
  });

  it('returns nothing when there is no number to dial', () => {
    expect(phoneCandidates('sin numero')).toEqual([]);
    expect(phoneCandidates(null)).toEqual([]);
  });
});
