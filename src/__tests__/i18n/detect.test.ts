import {
  detectLanguage,
  detectLanguageChangeRequest,
  parseLanguageMenuChoice,
  DETECTION_THRESHOLD,
} from '../../i18n/detect.js';
import { SupportedLanguage } from '../../i18n/languages.js';

describe('detectLanguageChangeRequest', () => {
  describe('banderas', () => {
    const cases: [string, SupportedLanguage][] = [
      ['🇧🇷', 'pt'],
      ['🇵🇹', 'pt'],
      ['🇬🇧', 'en'],
      ['🇺🇸', 'en'],
      ['🇪🇸', 'es'],
      ['🇦🇷', 'es'],
      ['🇲🇽', 'es'],
    ];

    it.each(cases)('%s → %s', (text, expected) => {
      expect(detectLanguageChangeRequest(text)).toEqual({ language: expected, source: 'flag' });
    });

    it('reconoce la bandera dentro de una frase', () => {
      expect(detectLanguageChangeRequest('hola 🇧🇷 por favor')).toEqual({
        language: 'pt',
        source: 'flag',
      });
    });
  });

  describe('el mensaje es solo el nombre de un idioma', () => {
    const cases: [string, SupportedLanguage][] = [
      ['english', 'en'],
      ['English', 'en'],
      ['inglés', 'en'],
      ['ingles', 'en'],
      ['português', 'pt'],
      ['portugues', 'pt'],
      ['portuguese', 'pt'],
      ['español', 'es'],
      ['castellano', 'es'],
      ['spanish', 'es'],
    ];

    it.each(cases)('%s → %s', (text, expected) => {
      expect(detectLanguageChangeRequest(text)?.language).toBe(expected);
    });
  });

  describe('verbo de cambio + idioma', () => {
    const cases: [string, SupportedLanguage][] = [
      ['quiero cambiar el idioma a inglés', 'en'],
      ['quiero cambiar el idioma en castellano', 'es'],
      ['podés hablar en portugués?', 'pt'],
      ['can you speak in english', 'en'],
      ['please switch to portuguese', 'pt'],
      ['você pode falar em espanhol', 'es'],
      ['prefiero seguir en inglés', 'en'],
    ];

    it.each(cases)('%s → %s', (text, expected) => {
      expect(detectLanguageChangeRequest(text)?.language).toBe(expected);
    });
  });

  describe('falsos positivos — NO deben cambiar el idioma', () => {
    // El riesgo #2 del plan: ES y PT son cercanos y la gente menciona
    // nacionalidades e idiomas al pasar mientras reserva.
    const cases = [
      'vinieron unos amigos brasileños',
      'somos 4, dos hablan inglés',
      'la reserva es para un grupo de italianos',
      'mesa para 6 personas',
      'quiero reservar para mañana',
      'ok',
      '2',
      '👍',
      'gracias!',
      'mi apellido es English',
      '',
      '   ',
    ];

    it.each(cases)('%p → null', (text) => {
      expect(detectLanguageChangeRequest(text)).toBeNull();
    });
  });
});

describe('parseLanguageMenuChoice', () => {
  // El orden del menú es es, en, pt (LANGUAGE_MENU_ORDER).
  const cases: [string, SupportedLanguage][] = [
    ['1', 'es'],
    ['2', 'en'],
    ['3', 'pt'],
    ['1️⃣', 'es'],
    ['3️⃣', 'pt'],
    ['opción 2', 'en'],
  ];

  it.each(cases)('%p → %s', (text, expected) => {
    expect(parseLanguageMenuChoice(text)?.language).toBe(expected);
  });

  it('acepta banderas dentro del menú', () => {
    expect(parseLanguageMenuChoice('🇧🇷')?.language).toBe('pt');
  });

  it('acepta el nombre suelto sin verbo de cambio', () => {
    expect(parseLanguageMenuChoice('quiero español por favor')?.language).toBe('es');
  });

  it('devuelve null para una respuesta que no es una elección', () => {
    // El caso que hace no bloqueante al menú: el cliente ignora las opciones y
    // responde su nombre — debe caer al parseo de nombre normal.
    expect(parseLanguageMenuChoice('Matías Andrada')).toBeNull();
  });

  it('un número fuera de rango no elige idioma', () => {
    expect(parseLanguageMenuChoice('9')).toBeNull();
  });
});

describe('detectLanguage', () => {
  describe('detección con confianza suficiente', () => {
    const cases: [string, SupportedLanguage][] = [
      ['hola, quiero una mesa para 4', 'es'],
      ['hi, table for 4 tomorrow', 'en'],
      ['bom dia, mesa pra 4 amanhã', 'pt'],
      ['hello', 'en'],
      ['oi', 'pt'],
      ['hola', 'es'],
      ['boa noite', 'pt'],
      ['good evening', 'en'],
      ['buenas noches', 'es'],
      ["I'd like to book a table for tomorrow, thanks", 'en'],
      ['queria reservar uma mesa para quinta, obrigado', 'pt'],
      ['quisiera reservar una mesa para el jueves, gracias', 'es'],
    ];

    it.each(cases)('%p → %s', (text, expected) => {
      const result = detectLanguage(text);
      expect(result).not.toBeNull();
      expect(result!.language).toBe(expected);
      expect(result!.confidence).toBeGreaterThanOrEqual(DETECTION_THRESHOLD);
    });
  });

  describe('sin señal suficiente → null', () => {
    const cases = ['ok', '2', '👍', '21:00', '', '   ', 'Matías'];

    it.each(cases)('%p → null', (text) => {
      expect(detectLanguage(text)).toBeNull();
    });
  });

  it('no confunde "hola" (es) con "olá" (pt)', () => {
    expect(detectLanguage('hola')!.language).toBe('es');
    expect(detectLanguage('olá')!.language).toBe('pt');
  });
});
