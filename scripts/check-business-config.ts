#!/usr/bin/env ts-node

/**
 * Script para verificar la configuración de un negocio
 * Muestra: zonas, mesas, capacidades
 */

import { SupabaseConfig } from '../src/config/supabase';
import { logger } from '../src/utils/logger';
import type { Business, Zone, Table, WaitlistEntry } from '../src/types';

const BUSINESS_ID = process.env.BUSINESS_ID || '8361f000-d50c-4c9c-b5d7-1b9fd3b60838';

async function checkBusinessConfig() {
  try {
    logger.info('🔍 Checking business configuration', { businessId: BUSINESS_ID });

    const client = SupabaseConfig.getClient();

    // Get business info
    const { data: business, error: businessError } = await client
      .from('businesses')
      .select('*')
      .eq('id', BUSINESS_ID)
      .single();

    if (businessError || !business) {
      logger.error('❌ Error fetching business', { error: businessError });
      return;
    }

    const typedBusiness = business as Business;

    logger.info('✅ Business found', {
      id: typedBusiness.id,
      name: typedBusiness.name,
      whatsapp_phone: typedBusiness.whatsapp_phone_number,
    });

    // Get zones
    const { data: zones, error: zonesError } = await client
      .from('zones')
      .select('*')
      .eq('business_id', BUSINESS_ID)
      .order('priority', { ascending: false });

    if (zonesError || !zones) {
      logger.error('❌ Error fetching zones', { error: zonesError });
      return;
    }

    const typedZones = zones as Zone[];

    logger.info(`📍 Zones (${typedZones?.length || 0}):`, {
      zones: typedZones?.map(z => ({
        id: z.id,
        name: z.name,
        priority: z.priority,
      })),
    });

    // Get tables
    const { data: tables, error: tablesError } = await client
      .from('tables')
      .select('*')
      .eq('business_id', BUSINESS_ID)
      .order('zone_id', { ascending: true });

    if (tablesError || !tables) {
      logger.error('❌ Error fetching tables', { error: tablesError });
      return;
    }

    const typedTables = tables as Table[];

    logger.info(`🪑 Tables (${typedTables?.length || 0}):`, {
      tables: typedTables?.map(t => ({
        id: t.id,
        zone_id: t.zone_id,
        table_number: t.table_number,
        capacity: t.capacity,
        is_active: t.is_active,
      })),
    });

    // Group tables by zone
    const tablesByZone = new Map<string, Table[]>();
    
    typedZones?.forEach(zone => {
      const zoneTables = typedTables?.filter(t => t.zone_id === zone.id) || [];
      tablesByZone.set(zone.name, zoneTables);
    });

    logger.info('📊 Tables grouped by zone:');
    tablesByZone.forEach((zoneTables, zoneName) => {
      logger.info(`  ${zoneName}: ${zoneTables.length} tables`, {
        tables: zoneTables.map(t => ({
          number: t.table_number,
          capacity: t.capacity,
        })),
      });
    });

    // Check waitlist entries
    const { data: waitlistEntries, error: waitlistError } = await client
      .from('waitlist_entries')
      .select('*')
      .eq('business_id', BUSINESS_ID)
      .order('created_at', { ascending: false })
      .limit(5);

    if (waitlistError) {
      logger.error('❌ Error fetching waitlist entries', { error: waitlistError });
    } else if (waitlistEntries) {
      const typedEntries = waitlistEntries as WaitlistEntry[];
      logger.info(`📋 Recent waitlist entries (${typedEntries?.length || 0}):`, {
        entries: typedEntries?.map(e => ({
          id: e.id,
          display_code: e.display_code,
          party_size: e.party_size,
          status: e.status,
          created_at: e.created_at,
        })),
      });
    }

  } catch (error) {
    logger.error('❌ Error checking business config', { error });
  } finally {
    process.exit(0);
  }
}

checkBusinessConfig();
