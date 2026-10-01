import { antigalAdaptation } from './antigal.js';
import { deLaFonteAdaptation } from './de-la-fonte.js';
import { laMisionAdaptation } from './la-mision.js';
import { skyAdaptation } from './sky.js';
import { matchesBusiness, type SharedNumberAdaptation } from './shared-number.js';

export {
  handOffWithoutReply,
  interceptSharedNumberTurn,
  isBotMuted,
  markWelcomeMenuShown,
  registerHumanReply,
  type SharedNumberAdaptation,
  type SharedNumberOutcome,
  type WelcomeEvent,
} from './shared-number.js';
export { isPhoneAutoReply, noteCustomerMessage } from './phone-auto-replies.js';

/**
 * Los locales que comparten su número de WhatsApp entre el bot y una persona.
 *
 * Agregar uno es agregar un archivo acá al lado y una línea en esta lista. El
 * orden importa sólo si dos adaptaciones pudieran matchear el mismo comercio,
 * cosa que hoy no pasa: gana la primera.
 */
const SHARED_NUMBER_ADAPTATIONS: SharedNumberAdaptation[] = [
  deLaFonteAdaptation,
  skyAdaptation,
  laMisionAdaptation,
  antigalAdaptation,
];

/**
 * La adaptación de este comercio, o `null` si atiende con el flujo normal —
 * que es el caso de todos menos dos.
 */
export function findSharedNumberAdaptation(businessId: string): SharedNumberAdaptation | null {
  return (
    SHARED_NUMBER_ADAPTATIONS.find((adaptation) => matchesBusiness(adaptation, businessId)) ??
    null
  );
}
