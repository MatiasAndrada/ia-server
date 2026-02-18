/**
 * Formatting utilities for text transformation
 */

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
