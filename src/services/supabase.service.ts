import { SupabaseConfig } from '../config/supabase';
import type { Database } from '../types/supabase';
import { formatName } from '../utils/formatters';
import {
  CreateReservationRequest,
  CreateReservationResponse,
  WaitlistStatus,
  Business,
  Customer,
  Table,
  WaitlistEntry,
  BlockedDateEntry,
} from '../types';
import { logger } from '../utils/logger';
import { ollamaService } from './ollama.service';

// Helper types for strict type safety without explicit imports
type WaitlistEntriesRow = Database['public']['Tables']['waitlist_entries']['Row'];
type CustomersUpdate = Database['public']['Tables']['customers']['Update'];
type CustomersInsert = Database['public']['Tables']['customers']['Insert'];
type WaitlistEntriesInsert = Database['public']['Tables']['waitlist_entries']['Insert'];
type WaitlistEntriesUpdate = Database['public']['Tables']['waitlist_entries']['Update'];
type BusinessesUpdate = Database['public']['Tables']['businesses']['Update'];
type BusinessBlockedDatesRow = Database['public']['Tables']['business_blocked_dates']['Row'];

export class SupabaseService {
  private static getClient() {
    return SupabaseConfig.getClient();
  }

  /**
   * Get all businesses
   */
  static async getAllBusinesses(): Promise<Business[]> {
    try {
      const client = this.getClient();
      const { data: businesses, error } = await client
        .from('businesses')
        .select('*')
        .order('name', { ascending: true });

      if (error) {
        logger.error('Error getting businesses', { error });
        return [];
      }

      logger.info('Businesses fetched', { count: businesses?.length || 0 });
      return (businesses as Business[]) || [];
    } catch (error) {
      logger.error('Error getting businesses', { error });
      return [];
    }
  }

  /**
   * Get all tables for a business
   */
  static async getTablesByBusiness(businessId: string): Promise<Table[]> {
    try {
      console.log('\n🪑 [DEBUG] getTablesByBusiness called');
      console.log('📍 Business ID:', businessId);
      
      const client = this.getClient();
      const { data: tablesData, error } = await client
        .from('tables')
        .select('*')
        .eq('business_id', businessId)
        .eq('is_active', true)
        .eq('is_occupied', false)
        .order('name', { ascending: true });

      console.log('🔍 [DEBUG] Tables query result:', {
        hasError: !!error,
        dataCount: tablesData?.length || 0,
      });

      if (error) {
        console.error('❌ [DEBUG] Error fetching tables:', error);
        throw error;
      }

      const tables = (tablesData as Table[] | null) ?? [];
      
      console.log('✅ [DEBUG] Tables returned:', tables.map(t => ({
        id: t.id,
        name: t.name,
        capacity: t.capacity,
        business_id: t.business_id
      })));

      logger.info('Tables fetched', {
        businessId,
        count: tables.length,
      });

      return tables;
    } catch (error) {
      logger.error('Error getting tables', { error, businessId });
      throw error;
    }
  }

  /**
   * Get all active tables for a business (including occupied tables)
   */
  static async getActiveTablesByBusiness(businessId: string): Promise<Table[]> {
    try {
      console.log('\n🪑 [DEBUG] getActiveTablesByBusiness called');
      console.log('📍 Business ID:', businessId);

      const client = this.getClient();
      const { data: tablesData, error } = await client
        .from('tables')
        .select('*')
        .eq('business_id', businessId)
        .eq('is_active', true)
        .order('name', { ascending: true });

      console.log('🔍 [DEBUG] Active tables query result:', {
        hasError: !!error,
        dataCount: tablesData?.length || 0,
      });

      if (error) {
        console.error('❌ [DEBUG] Error fetching active tables:', error);
        throw error;
      }

      const tables = (tablesData as Table[] | null) ?? [];

      logger.info('Active tables fetched', {
        businessId,
        count: tables.length,
      });

      return tables;
    } catch (error) {
      logger.error('Error getting active tables', { error, businessId });
      throw error;
    }
  }

  /**
   * Get or create a customer by phone number
   */
  static async getOrCreateCustomer(
    name: string,
    phone: string,
    businessId: string
  ): Promise<Customer> {
    try {
      const client = this.getClient();
      
      // Format name with capitalized first letter of each word
      const formattedName = formatName(name);

      // Try to find existing customer for this business
      const { data: existingCustomerData, error: findError } = await client
        .from('customers')
        .select('*')
        .eq('phone', phone)
        .eq('business_id', businessId)
        .maybeSingle();

      if (findError) {
        throw findError;
      }

      // If customer exists, update lastSeenAt and return it
      const existingCustomer = existingCustomerData as Customer | null;

      if (existingCustomer) {
        const updateData: CustomersUpdate = {
          last_seen_at: new Date().toISOString(),
          name: formattedName,
        };

        const { data: updatedCustomerData, error: updateError } = await client
          .from('customers')
          .update(updateData)
          .eq('id', existingCustomer.id)
          .select('*')
          .single();

        if (updateError) {
          throw updateError;
        }

        const updatedCustomer = updatedCustomerData as Customer;
        logger.info('Customer found and updated', { customerId: updatedCustomer.id, phone });
        return updatedCustomer;
      }

      // Otherwise, create new customer
      const insertData: CustomersInsert = {
        name: formattedName,
        phone,
        business_id: businessId,
        last_seen_at: new Date().toISOString(),
      };

      const { data: newCustomerData, error: insertError } = await client
        .from('customers')
        .insert(insertData)
        .select('*')
        .single();

      if (insertError) {
        throw insertError;
      }

      const newCustomer = newCustomerData as Customer;
      logger.info('Customer created', { customerId: newCustomer.id, phone, businessId });
      return newCustomer;
    } catch (error) {
      logger.error('Supabase: getOrCreateCustomer failed', { error, phone, businessId });
      throw error;
    }
  }

  /**
   * Create a new waitlist entry (reservation)
   */
  static async createReservation(
    request: CreateReservationRequest
  ): Promise<CreateReservationResponse> {
    try {
      logger.info('🎯 Starting reservation creation', {
        businessId: request.businessId,
        customerName: request.customerName,
        customerPhone: request.customerPhone,
        partySize: request.partySize,
        tableId: request.tableId,
      });

      const client = this.getClient();

      // Get or create customer
      logger.info('📞 Getting or creating customer...');
      const customer = await this.getOrCreateCustomer(
        request.customerName,
        request.customerPhone,
        request.businessId
      );
      logger.info('✅ Customer ready', { customerId: customer.id, name: customer.name });

      // Check for an existing active reservation (any date — max 1 active at a time)
      const existingReservation = await this.getActiveReservation(customer.id, request.businessId);
      if (existingReservation) {
        logger.info('⚠️ Customer already has an active reservation', {
          customerId: customer.id,
          entryId: existingReservation.id,
          displayCode: existingReservation.display_code,
        });
        return {
          success: true,
          waitlistEntry: existingReservation,
          alreadyExists: true,
        };
      }

      // Generate display code based on customer initial and phone suffix
      const baseDisplayCode = this.generateDisplayCodeFromCustomer(
        request.customerName,
        request.customerPhone
      );
      const displayCode = await this.ensureUniqueDisplayCode(
        client,
        request.businessId,
        baseDisplayCode
      );

      // Get business configuration to check auto_accept_reservations
      logger.info('⚙️ Getting business configuration...');
      const business = await this.getBusinessById(request.businessId);
      const autoAccept = business?.auto_accept_reservations ?? false;
      logger.info('✅ Business configuration retrieved', { 
        businessId: request.businessId, 
        autoAcceptReservations: autoAccept 
      });

      let tableId: string | null = null;

      // Verify table if provided
      if (request.tableId) {
        const { data: tableData, error: tableError } = await client
          .from('tables')
          .select('id, capacity')
          .eq('id', request.tableId)
          .eq('business_id', request.businessId)
          .eq('is_active', true)
          .eq('is_occupied', false)
          .maybeSingle();

        if (tableError) {
          throw tableError;
        }

        const table = tableData as Pick<Table, 'id' | 'capacity'> | null;
        if (!table) {
          logger.error('Table not found', {
            tableId: request.tableId,
          });
          return {
            success: false,
            error: 'La mesa seleccionada no está disponible',
          };
        }

        if (table.capacity !== null && table.capacity < request.partySize) {
          logger.error('Table capacity is not enough for party size', {
            tableId: request.tableId,
            tableCapacity: table.capacity,
            partySize: request.partySize,
          });
          return {
            success: false,
            error: 'La mesa seleccionada no tiene capacidad suficiente',
          };
        }

        tableId = request.tableId;
      }

      // Create waitlist entry
      const initialStatus: WaitlistStatus = autoAccept ? 'CONFIRMED' : 'WAITING';
      const confirmedAt = autoAccept ? new Date().toISOString() : null;
      
      logger.info('💾 Creating waitlist entry in database...', {
        businessId: request.businessId,
        customerId: customer.id,
        partySize: request.partySize,
        displayCode,
        status: initialStatus,
        confirmedAt,
        tableId: tableId || null,
        autoAccept,
      });

      const insertData: WaitlistEntriesInsert = {
        business_id: request.businessId,
        customer_id: customer.id,
        party_size: request.partySize,
        display_code: displayCode,
        status: initialStatus,
        source: request.source ?? 'AI_CHAT',
        table_id: tableId,
        scheduled_at: request.scheduledAt ?? null,
        ...(confirmedAt ? { confirmed_at: confirmedAt } : {}),
      };

      const { data: waitlistEntryData, error: entryError } = await client
        .from('waitlist_entries')
        .insert(insertData)
        .select('*')
        .single();

      if (entryError) {
        logger.error('❌ Error creating waitlist entry', {
          error: entryError,
          code: entryError.code,
          message: entryError.message,
          details: entryError.details,
        });
        throw entryError;
      }

      if (!waitlistEntryData) {
        logger.error('❌ Waitlist entry created but no data returned');
        throw new Error('No data returned from insert');
      }

      const waitlistEntry = waitlistEntryData as WaitlistEntriesRow;

      logger.info('✅ Waitlist entry created successfully!', {
        entryId: waitlistEntry.id,
        displayCode: waitlistEntry.display_code,
        businessId: waitlistEntry.business_id,
        customerId: waitlistEntry.customer_id,
        partySize: waitlistEntry.party_size,
        status: waitlistEntry.status,
        tableId: waitlistEntry.table_id,
      });

      return {
        success: true,
        waitlistEntry: waitlistEntry as WaitlistEntry,
      };
    } catch (error) {
      logger.error('Supabase: createReservation failed', { error, request });
      return {
        success: false,
        error: 'Error inesperado al crear la reserva',
      };
    }
  }

  /**
   * Generate display code based on customer initial and phone suffix
   */
  private static generateDisplayCodeFromCustomer(name: string, phone: string): string {
    const trimmedName = (name || '').trim();
    const initial = trimmedName ? trimmedName[0].toUpperCase() : 'X';
    const digits = (phone || '').replace(/\D/g, '');
    const lastThree = digits.slice(-3).padStart(3, '0');
    return `${initial}${lastThree}`;
  }

  private static async ensureUniqueDisplayCode(
    client: ReturnType<typeof SupabaseService.getClient>,
    businessId: string,
    baseCode: string
  ): Promise<string> {
    const activeStatuses: WaitlistStatus[] = ['WAITING', 'CONFIRMED', 'NOTIFIED'];
    let displayCode = baseCode;

    for (let attempt = 0; attempt < 26; attempt += 1) {
      const { data, error } = await client
        .from('waitlist_entries')
        .select('id')
        .eq('business_id', businessId)
        .eq('display_code', displayCode)
        .in('status', activeStatuses)
        .limit(1)
        .maybeSingle();

      if (error) {
        throw error;
      }

      if (!data) {
        return displayCode;
      }

      displayCode = `${this.randomDisplayInitial(baseCode[0])}${baseCode.slice(1)}`;
    }

    return displayCode;
  }

  // ========================
  // Active reservation lookup
  // ========================

  /**
   * Get the customer's active reservation (WAITING / CONFIRMED / NOTIFIED),
   * regardless of date — a customer may have at most one active reservation
   * at a time, whether it's instant (today) or scheduled for a future day.
   */
  static async getActiveReservation(
    customerId: string,
    businessId: string
  ): Promise<WaitlistEntry | null> {
    try {
      const client = this.getClient();

      const { data, error } = await client
        .from('waitlist_entries')
        .select('*')
        .eq('customer_id', customerId)
        .eq('business_id', businessId)
        .in('status', ['WAITING', 'CONFIRMED', 'NOTIFIED'])
        .order('queued_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (error) throw error;
      return (data as WaitlistEntry | null);
    } catch (error) {
      logger.error('Error getting active reservation', { error, customerId, businessId });
      return null;
    }
  }

  /**
   * Get the customer's active reservation (any date) by phone number.
   */
  static async getActiveReservationByPhone(
    phone: string,
    businessId: string
  ): Promise<WaitlistEntry | null> {
    try {
      const client = this.getClient();

      const { data: customerData, error: customerError } = await client
        .from('customers')
        .select('id')
        .eq('business_id', businessId)
        .eq('phone', phone)
        .maybeSingle();

      if (customerError) throw customerError;
      if (!customerData) return null;

      return this.getActiveReservation(customerData.id, businessId);
    } catch (error) {
      logger.error('Error getting active reservation by phone', { error, phone, businessId });
      return null;
    }
  }

  /**
   * Update the party_size of an existing waitlist entry.
   */
  static async updateReservationPartySize(
    reservationId: string,
    partySize: number
  ): Promise<boolean> {
    try {
      const client = this.getClient();
      const { error } = await client
        .from('waitlist_entries')
        .update({ party_size: partySize, updated_at: new Date().toISOString() })
        .eq('id', reservationId);

      if (error) throw error;
      logger.info('Reservation party size updated', { reservationId, partySize });
      return true;
    } catch (error) {
      logger.error('Error updating reservation party size', { error, reservationId });
      return false;
    }
  }

  /**
   * Update the scheduled day/time of an existing waitlist entry.
   * `scheduledAt: null` reverts the reservation to instant/turno actual.
   */
  static async updateReservationSchedule(
    reservationId: string,
    scheduledAt: string | null
  ): Promise<boolean> {
    try {
      const client = this.getClient();
      const { error } = await client
        .from('waitlist_entries')
        .update({ scheduled_at: scheduledAt, updated_at: new Date().toISOString() })
        .eq('id', reservationId);

      if (error) throw error;
      logger.info('Reservation schedule updated', { reservationId, scheduledAt });
      return true;
    } catch (error) {
      logger.error('Error updating reservation schedule', { error, reservationId });
      return false;
    }
  }

  private static randomDisplayInitial(exclude?: string): string {
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const filtered = exclude ? letters.replace(exclude.toUpperCase(), '') : letters;
    const idx = Math.floor(Math.random() * filtered.length);
    return filtered[idx] || 'X';
  }

  /**
   * Log a message
   */
  // Functionality moved to database MessageLog creation in service layer

  /**
   * Update waitlist entry status
   */
  static async updateReservationStatus(
    entryId: string,
    status: WaitlistStatus
  ): Promise<boolean> {
    try {
      const client = this.getClient();
      const updateData: WaitlistEntriesUpdate = {
        status,
        updated_at: new Date().toISOString(),
      };

      // Set specific timestamps based on status
      if (status === 'CONFIRMED') {
        updateData.confirmed_at = new Date().toISOString();
      } else if (status === 'SEATED') {
        updateData.seated_at = new Date().toISOString();
      }

      const { error } = await client
        .from('waitlist_entries')
        .update(updateData)
        .eq('id', entryId);

      if (error) {
        throw error;
      }

      logger.info('Waitlist entry status updated', { entryId, status });
      return true;
    } catch (error) {
      logger.error('Supabase: updateReservationStatus failed', { error, entryId });
      return false;
    }
  }

  /**
   * Get business by ID
   */
  static async getBusinessById(businessId: string): Promise<Business | null> {
    try {
      const client = this.getClient();
      const { data: businessData, error } = await client
        .from('businesses')
        .select('*')
        .eq('id', businessId)
        .maybeSingle();

      if (error) {
        throw error;
      }

      const business = businessData as Business | null;
      if (!business) {
        logger.warn('Business not found', { businessId });
        return null;
      }

      return business;
    } catch (error) {
      logger.error('Supabase: getBusinessById failed', { error, businessId });
      return null;
    }
  }

  /**
   * Get the dates ("YYYY-MM-DD") a business has explicitly blocked for new
   * reservations (business_blocked_dates). Each entry carries both the raw
   * owner-supplied `reason` and the AI-generated `reasonMessage`. Dates are
   * returned as-is from Postgres — no timezone conversion — to be compared
   * directly against other BA date keys.
   */
  static async getBlockedDates(businessId: string): Promise<Map<string, BlockedDateEntry>> {
    try {
      const client = this.getClient();
      const { data, error } = await client
        .from('business_blocked_dates')
        .select('date, reason, reason_message')
        .eq('business_id', businessId);
      console.log('🔍 [DEBUG] getBlockedDates query result:', {
        data, error
      });
      if (error) {
        throw error;
      }

      return new Map(
        (data ?? []).map((row) => [
          row.date,
          { reason: row.reason ?? null, reasonMessage: row.reason_message ?? null },
        ])
      );
    } catch (error) {
      logger.error('Supabase: getBlockedDates failed', { error, businessId });
      return new Map();
    }
  }

  /**
   * Persist a newly-generated AI client-facing message for a blocked date so
   * subsequent lookups can skip the Ollama call.
   */
  static async updateBlockedDateReasonMessage(
    businessId: string,
    date: string,
    reasonMessage: string
  ): Promise<void> {
    try {
      const client = this.getClient();
      const { error } = await client
        .from('business_blocked_dates')
        .update({ reason_message: reasonMessage })
        .eq('business_id', businessId)
        .eq('date', date);

      if (error) throw error;

      logger.info('Supabase: blocked date reason_message updated', { businessId, date });
    } catch (error) {
      logger.warn('Supabase: updateBlockedDateReasonMessage failed (non-critical)', {
        error,
        businessId,
        date,
      });
    }
  }

  /**
   * Create a business_blocked_dates row. When a `reason` is given, an AI
   * (Ollama) generated, client-facing `reason_message` is produced and
   * stored alongside it, so customers get a professional explanation
   * instead of just the owner's short/informal reason.
   */
  static async createBlockedDate(
    businessId: string,
    date: string,
    reason?: string | null
  ): Promise<BusinessBlockedDatesRow | null> {
    try {
      const trimmedReason = reason?.trim() || null;

      let reasonMessage: string | null = null;
      if (trimmedReason) {
        const business = await this.getBusinessById(businessId);
        reasonMessage = await ollamaService.generateBlockedDateReasonMessage(
          trimmedReason,
          business?.name,
          business?.type
        );
      }

      const client = this.getClient();
      const { data, error } = await client
        .from('business_blocked_dates')
        .insert({
          business_id: businessId,
          date,
          reason: trimmedReason,
          reason_message: reasonMessage,
        })
        .select()
        .single();

      if (error) {
        throw error;
      }

      logger.info('Supabase: blocked date created', {
        businessId,
        date,
        hasReasonMessage: !!reasonMessage,
      });

      return data as BusinessBlockedDatesRow;
    } catch (error) {
      logger.error('Supabase: createBlockedDate failed', { error, businessId, date });
      return null;
    }
  }

  /**
   * Check if business has active WhatsApp session
   */
  static async isBusinessWhatsAppActive(businessId: string): Promise<boolean> {
    try {
      const business = await this.getBusinessById(businessId);
      return business?.whatsapp_session_id !== null && business?.whatsapp_session_id !== undefined;
    } catch (error) {
      logger.error('Error checking WhatsApp status', { error, businessId });
      return false;
    }
  }

  /**
   * Check if business AI chat flow is enabled.
   * Defaults to enabled when the flag is missing to avoid accidental service lockout.
   */
  static async isBusinessAiChatEnabled(businessId: string): Promise<boolean> {
    try {
      const business = await this.getBusinessById(businessId);

      if (!business) {
        return true;
      }

      return business.ai_chat_enabled ?? true;
    } catch (error) {
      logger.error('Error checking AI chat enabled flag', { error, businessId });
      return true;
    }
  }

  /**
   * Update business WhatsApp status
   */
  static async updateBusinessWhatsAppStatus(
    businessId: string,
    sessionId?: string,
    phoneNumber?: string
  ): Promise<boolean> {
    try {
      logger.debug('Starting updateBusinessWhatsAppStatus', { businessId, sessionId, phoneNumber });
      
      const client = this.getClient();
      logger.debug('Supabase client retrieved', { isInitialized: !!client });
      
      const updateData: BusinessesUpdate = {
        updated_at: new Date().toISOString(),
      };

      if (sessionId) {
        updateData.whatsapp_session_id = sessionId;
      }

      if (phoneNumber) {
        updateData.whatsapp_phone_number = phoneNumber;
      }

      logger.debug('Executing update query', { 
        businessId, 
        updateDataKeys: Object.keys(updateData),
        tableName: 'businesses'
      });

      const { error, data } = await client
        .from('businesses')
        .update(updateData)
        .eq('id', businessId);

      logger.debug('Update query result', { 
        businessId, 
        hasError: !!error, 
        errorCode: (error as any)?.code,
        dataReturned: !!data
      });

      if (error) {
        logger.error('Supabase update error details', { 
          businessId,
          errorCode: (error as any)?.code,
          errorMessage: (error as any)?.message,
          errorDetails: (error as any)?.details,
          errorHint: (error as any)?.hint
        });
        throw error;
      }

      logger.info('Business WhatsApp status updated successfully', { businessId, sessionId });
      return true;
    } catch (error) {
      logger.error('Error updating WhatsApp status', { 
        error, 
        businessId,
        errorStack: (error as any)?.stack 
      });
      return false;
    }
  }
}
