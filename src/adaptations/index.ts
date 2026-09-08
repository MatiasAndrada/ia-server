import { deLaFonteAdaptation } from './de-la-fonte.js';
import { skyAdaptation } from './sky.js';
import { matchesBusiness, type SharedNumberAdaptation } from './shared-number.js';

export {
  interceptSharedNumberTurn,
  type SharedNumberAdaptation,
  type SharedNumberOutcome,
  type WelcomeEvent,
} from './shared-number.js';

/**
 * Los locales que comparten su número de WhatsApp entre el bot y una persona.
 *
 * Agregar uno es agregar un archivo acá al lado y una línea en esta lista. El
 * orden importa sólo si dos adaptaciones pudieran matchear el mismo comercio,
 * cosa que hoy no pasa: gana la primera.
 */
const SHARED_NUMBER_ADAPTATIONS: SharedNumberAdaptation[] = [deLaFonteAdaptation, skyAdaptation];

/**
 * La adaptación de este comercio, o `null` si atiende con el flujo normal —
 * que es el caso de todos menos dos.
 */
export function findSharedNumberAdaptation(
  businessId: string,
  businessName?: string | null
): SharedNumberAdaptation | null {
  return (
    SHARED_NUMBER_ADAPTATIONS.find((adaptation) =>
      matchesBusiness(adaptation, businessId, businessName)
    ) ?? null
  );
}
