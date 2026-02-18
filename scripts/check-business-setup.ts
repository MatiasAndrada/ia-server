import { SupabaseConfig } from '../src/config/supabase';
import { SupabaseService } from '../src/services/supabase.service';
import * as dotenv from 'dotenv';

dotenv.config();

const BUSINESS_ID = process.env.TEST_BUSINESS_ID || '8361f000-d50c-4c9c-b5d7-1b9fd3b60838';

async function checkBusinessSetup() {
  try {
    console.log('\n🔍 Checking business setup...\n');
    console.log(`Business ID: ${BUSINESS_ID}\n`);

    // Initialize Supabase
    SupabaseConfig.initialize();

    if (!SupabaseConfig.isReady()) {
      console.error('❌ Supabase not initialized');
      return;
    }

    // Get business
    console.log('📋 Fetching business details...');
    const business = await SupabaseService.getBusinessById(BUSINESS_ID);
    console.log('✅ Business:', {
      id: business?.id,
      name: business?.name,
      whatsapp_phone: business?.whatsapp_phone_number,
      whatsapp_session: business?.whatsapp_session_id,
    });

    // Get zones
    console.log('\n🏢 Fetching zones...');
    const zones = await SupabaseService.getZonesByBusiness(BUSINESS_ID);
    console.log(`✅ Found ${zones.length} zones:`);
    zones.forEach((zone, idx) => {
      console.log(`   ${idx + 1}. ${zone.name} (ID: ${zone.id}, Priority: ${zone.priority})`);
    });

    // Get tables
    console.log('\n🪑 Fetching tables...');
    const tables = await SupabaseService.getTablesByBusiness(BUSINESS_ID);
    console.log(`✅ Found ${tables.length} tables:`);
    
    // Group tables by zone
    const tablesByZone = new Map<string, typeof tables>();
    tables.forEach(table => {
      const zoneId = table.zone_id || 'no-zone';
      if (!tablesByZone.has(zoneId)) {
        tablesByZone.set(zoneId, []);
      }
      tablesByZone.get(zoneId)!.push(table);
    });

    zones.forEach(zone => {
      const zoneTables = tablesByZone.get(zone.id) || [];
      console.log(`\n   Zone: ${zone.name} (${zoneTables.length} tables)`);
      zoneTables.forEach(table => {
        console.log(`      - Table ${table.table_number}: Capacity ${table.capacity}, Active: ${table.is_active}`);
      });
    });

    // Check for tables without zone
    const noZoneTables = tablesByZone.get('no-zone') || [];
    if (noZoneTables.length > 0) {
      console.log(`\n   ⚠️  Tables without zone: ${noZoneTables.length}`);
      noZoneTables.forEach(table => {
        console.log(`      - Table ${table.table_number}: Capacity ${table.capacity}`);
      });
    }

    // Test reservation flow
    console.log('\n🧪 Testing reservation flow for different party sizes...');
    const testSizes = [2, 4, 6, 8];
    for (const size of testSizes) {
      console.log(`\n   Party size: ${size}`);
      const { ReservationService } = await import('../src/services/reservation.service');
      const zonesWithTables = await ReservationService.getAvailableZonesWithTables(
        BUSINESS_ID,
        size
      );
      
      console.log(`   Available zones: ${zonesWithTables.size}`);
      zonesWithTables.forEach((value, zoneName) => {
        console.log(`      - ${zoneName}: ${value.tables.length} tables`);
      });
    }

    console.log('\n✅ Business setup check complete!\n');
  } catch (error) {
    console.error('❌ Error checking business setup:', error);
    if (error instanceof Error) {
      console.error('Error message:', error.message);
      console.error('Error stack:', error.stack);
    }
  }
}

checkBusinessSetup();
