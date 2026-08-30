/**
 * Formatting utilities for text transformation
 */

/**
 * WhatsApp bold uses a single asterisk (*texto*), not Markdown's double
 * asterisk (**texto**). LLM-generated replies sometimes slip into Markdown
 * style anyway, so any run of 2+ asterisks lands on the client as literal
 * "**" instead of bold — collapse those runs to one asterisk right before
 * sending.
 */
export function normalizeWhatsAppBold(text: string): string {
  if (!text) {
    return text;
  }

  return text.replace(/\*{2,}/g, '*');
}

/**
 * Capitalizes the first letter of each word in a name
 * Examples:
 * - "matías andrada" → "Matías Andrada"
 * - "JUAN PEREZ" → "Juan Perez"
 * - "ana maria lopez" → "Ana Maria Lopez"
 */
export function formatName(name: string): string {
  if (!name || typeof name !== 'string') {
    return name;
  }

  return name
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .map(word => {
      if (word.length === 0) return word;
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(' ');
}
