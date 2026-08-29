import { SupabaseService } from '../../services/supabase.service.js';
import { Business, BlockedDateEntry, WeeklyHours } from '../../types/index.js';
import { isDateBlocked, nowInBuenosAires } from '../../utils/reservation-datetime.js';

/**
 * Todo lo que las reglas de negocio necesitan de un comercio, resuelto de una
 * sola vez por turno.
 *
 * Existe porque `businesses` y `business_blocked_dates` se consultan en casi
 * toda herramienta de disponibilidad, y sin esto un turno con tres tool calls
 * pegaba nueve veces contra Supabase. `SupabaseService.getBusinessById` ya
 * cachea en Redis, pero la fusión de márgenes y el cierre sobre `isDateBlocked`
 * se repetían igual en cada call site.
 */
export interface BusinessRules {
  business: Business;
  weeklyHours: WeeklyHours;
  blockedDates: ReadonlyMap<string, BlockedDateEntry>;
  /** Minutos antes del cierre en que ya no se toman reservas. */
  closingMargin: number;
  /** Minutos después de la apertura antes de aceptar la primera reserva. */
  openingMargin: number;
  /** "Hoy" en hora de Buenos Aires, congelado para todo el turno. */
  nowBA: Date;
  /** Cierre parcial sobre `blockedDates`, que es la forma en que lo piden los helpers. */
  isBlocked: (dateKey: string) => boolean;
}

export async function loadBusinessRules(businessId: string): Promise<BusinessRules | null> {
  const [business, blockedDates] = await Promise.all([
    SupabaseService.getBusinessById(businessId),
    SupabaseService.getBlockedDates(businessId),
  ]);

  if (!business) return null;

  const weeklyHours = (business.weekly_hours as WeeklyHours | null | undefined) ?? {};

  return {
    business,
    weeklyHours,
    blockedDates,
    closingMargin: business.reservation_closing_margin_minutes ?? 15,
    openingMargin: business.reservation_opening_margin_minutes ?? 0,
    nowBA: nowInBuenosAires(),
    isBlocked: (dateKey: string) => isDateBlocked(dateKey, blockedDates),
  };
}
