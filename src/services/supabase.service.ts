import { SupabaseConfig } from '../config/supabase';
import type { Database } from '../types/supabase';
import { formatName } from '../utils/formatters';
import {
  CreateReservationRequest,
  CreateReservationResponse,
  WaitlistStatus,
  Business,
  Customer,
  Zone,
  Table,
  WaitlistEntry,
} from '../types';
import { logger } from '../utils/logger';

// Helper types for strict type safety without explicit imports
type TablesRow = Database['public']['Tables']['tables']['Row'];
type WaitlistEntriesRow = Database['public']['Tables']['waitlist_entries']['Row'];
type CustomersUpdate = Database['public']['Tables']['customers']['Update'];
type CustomersInsert = Database['public']['Tables']['customers']['Insert'];
type WaitlistEntriesInsert = Database['public']['Tables']['waitlist_entries']['Insert'];
type WaitlistEntriesUpdate = Database['public']['Tables']['waitlist_entries']['Update'];
type BusinessesUpdate = Database['public']['Tables']['businesses']['Update'];

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
   * Test Supabase permissions - Run this to diagnose RLS issues
   */
  static async testPermissions(): Promise<void> {
    try {
      logger.info('Testing Supabase permissions...');
      const client = this.getClient();

      // Test 1: Can we read businesses?
      logger.info('Test 1: Reading businesses table...');
      const { error: readError, count } = await client
        .from('businesses')
        .select('*', { count: 'exact', head: true });

      if (readError) {
        logger.error('❌ READ permission denied on businesses', { error: readError });
      } else {
        logger.info('✅ READ permission OK on businesses', { count });
      }

      // Test 2: Can we update businesses?
      logger.info('Test 2: Updating a test business...');
      const { error: updateError } = await client
        .from('businesses')
        .update({ updated_at: new Date().toISOString() })
        .eq('id', '00000000-0000-0000-0000-000000000000')
        .is('name', null);

      if (updateError && updateError.code !== '42P01') {
        logger.error('❌ UPDATE permission denied on businesses', { error: updateError });
      } else if (updateError?.code === '42P01') {
        logger.info('Test business not found (expected), but UPDATE permission OK ✅');
      } else {
        logger.info('✅ UPDATE permission OK on businesses');
      }

      logger.info('Permission test complete');
    } catch (error) {
      logger.error('Error testing permissions', { error });
    }
  }
  static async getZonesByBusiness(businessId: string): Promise<Zone[]> {
    try {
      console.log('\n🔍 [DEBUG] getZonesByBusiness called');
      console.log('📍 Business ID:', businessId);
      
      const client = this.getClient();
      const { data: zonesData, error } = await client
        .from('zones')
        .select('*')
        .eq('business_id', businessId)
        .order('priority', { ascending: false })
        .order('name', { ascending: true });

      console.log('🔍 [DEBUG] Query result:', {
        hasError: !!error,
        dataCount: zonesData?.length || 0,
        rawData: zonesData
      });

      if (error) {
        console.error('❌ [DEBUG] Error fetching zones:', error);
        throw error;
      }

      const zones = (zonesData as Zone[] | null) ?? [];
      
      console.log('✅ [DEBUG] Zones returned:', zones.map(z => ({
        id: z.id,
        name: z.name,
        business_id: z.business_id
      })));

      logger.info('Zones fetched', {
        businessId,
        count: zones.length,
      });

      return zones;
    } catch (error) {
      logger.error('Error getting zones', { error, businessId });
      throw error;
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
        .order('zone_id', { ascending: true })
        .order('table_number', { ascending: true });

      console.log('🔍 [DEBUG] Tables query result:', {
        hasError: !!error,
        dataCount: tablesData?.length || 0,
        rawData: tablesData
      });

      if (error) {
        console.error('❌ [DEBUG] Error fetching tables:', error);
        throw error;
      }

      const tables = (tablesData as Table[] | null) ?? [];
      
      console.log('✅ [DEBUG] Tables returned:', tables.map(t => ({
        id: t.id,
        table_number: t.table_number,
        zone_id: t.zone_id,
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
        .order('zone_id', { ascending: true })
        .order('table_number', { ascending: true });

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
        zone: request.zone,
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

      // Get next position in waitlist
      logger.info('🔢 Calculating next position in waitlist...');
      const { data: lastEntry, error: lastEntryError } = await client
        .from('waitlist_entries')
        .select('position')
        .eq('business_id', request.businessId)
        .order('position', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (lastEntryError) {
        logger.error('❌ Error getting last entry position', { error: lastEntryError });
        throw lastEntryError;
      }

      const nextPosition = lastEntry?.position ? lastEntry.position + 1 : 1;
      logger.info('✅ Position calculated', { nextPosition, lastPosition: lastEntry?.position });

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

      // If zone is provided, find an available table in that zone
      if (request.zone) {
        logger.info('🏢 Searching for zone', { zoneName: request.zone });
        // Get zone by name
        const { data: zoneData, error: zoneError } = await client
          .from('zones')
          .select('id')
          .eq('business_id', request.businessId)
          .eq('name', request.zone)
          .maybeSingle();

        if (zoneError) {
          logger.error('❌ Error getting zone', { error: zoneError, zoneName: request.zone });
          throw zoneError;
        }

        if (zoneData) {
          const zoneId = zoneData.id;
          logger.info('✅ Zone found', { zoneId, zoneName: request.zone });

          // Find available table in this zone with sufficient capacity
          logger.info('🪑 Searching for available table', {
            zoneId,
            partySize: request.partySize,
          });
          const { data: tableData, error: tableError } = await client
            .from('tables')
            .select('*')
            .eq('business_id', request.businessId)
            .eq('zone_id', zoneId)
            .eq('is_active', true)
            .eq('is_occupied', false)
            .gte('capacity', request.partySize)
            .order('capacity', { ascending: true })
            .limit(1)
            .maybeSingle();

          if (tableError) {
            logger.error('❌ Error finding table', { error: tableError });
            throw tableError;
          }

          if (tableData) {
            const table = tableData as TablesRow;
            tableId = table.id;
            logger.info('✅ Table assigned for reservation', {
              tableId,
              tableNumber: table.table_number,
              zoneId,
              capacity: table.capacity,
              partySize: request.partySize,
            });
          } else {
            logger.warn('⚠️ No available table in zone', {
              zone: request.zone,
              zoneId,
              partySize: request.partySize,
            });
          }
        } else {
          logger.warn('⚠️ Zone not found', { zoneName: request.zone, businessId: request.businessId });
        }
      }

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
      const initialStatus: WaitlistStatus = autoAccept ? 'NOTIFIED' : 'WAITING';
      const notifiedAt = autoAccept ? new Date().toISOString() : undefined;
      
      logger.info('💾 Creating waitlist entry in database...', {
        businessId: request.businessId,
        customerId: customer.id,
        partySize: request.partySize,
        position: nextPosition,
        displayCode,
        status: initialStatus,
        notifiedAt,
        tableId: tableId || null,
        autoAccept,
      });

      const insertData: WaitlistEntriesInsert = {
        business_id: request.businessId,
        customer_id: customer.id,
        party_size: request.partySize,
        position: nextPosition,
        display_code: displayCode,
        status: initialStatus,
        notified_at: notifiedAt,
        table_id: tableId,
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
        position: waitlistEntry.position,
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
    const activeStatuses: WaitlistStatus[] = ['WAITING', 'NOTIFIED'];
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
      if (status === 'NOTIFIED') {
        updateData.notified_at = new Date().toISOString();
      } else if (status === 'ARRIVED') {
        updateData.notified_at = new Date().toISOString();
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
