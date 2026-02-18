import { SupabaseService } from '../src/services/supabase.service';
import { ReservationService } from '../src/services/reservation.service';
import { SupabaseConfig } from '../src/config/supabase';
import * as dotenv from 'dotenv';

dotenv.config();

const BUSINESS_ID = process.env.TEST_BUSINESS_ID || '8361f000-d50c-4c9c-b5d7-1b9fd3b60838';

async function testZonesAvailability() {
  try {
    console.log('\n🔍 Testing Zone Availability System\n');
    console.log('='.repeat(60));
    
    // Initialize Supabase
    SupabaseConfig.initialize();
    
    if (!SupabaseConfig.isReady()) {
      console.error('❌ Supabase not initialized');
      return;
    }
    
    // Get business
    const business = await SupabaseService.getBusinessById(BUSINESS_ID);
    if (!business) {
      console.log('❌ Business not found');
      return;
    }
    
    console.log(`\n📍 Business: ${business.name}`);
    console.log(`   ID: ${business.id}\n`);
    
    // Get all zones
    const zones = await SupabaseService.getZonesByBusiness(business.id);
    console.log(`📊 Total Zones in DB: ${zones.length}`);
    zones.forEach((zone, idx) => {
      console.log(`   ${idx + 1}. ${zone.name} (priority: ${zone.priority})`);
    });
    
    // Get all tables
    const tables = await SupabaseService.getTablesByBusiness(business.id);
    console.log(`\n🪑 Total Tables in DB: ${tables.length}`);
    
    // Group tables by zone
    const tablesByZoneId = new Map<string, any[]>();
    tables.forEach(table => {
      if (!table.zone_id) return; // Skip tables without zone
      if (!tablesByZoneId.has(table.zone_id)) {
        tablesByZoneId.set(table.zone_id, []);
      }
      tablesByZoneId.get(table.zone_id)!.push(table);
    });
    
    console.log('\n📋 Tables by Zone:');
    zones.forEach(zone => {
      const zoneTables = tablesByZoneId.get(zone.id) || [];
      const activeTables = zoneTables.filter(t => t.is_active);
      console.log(`\n   Zone: ${zone.name}`);
      console.log(`   - Total tables: ${zoneTables.length}`);
      console.log(`   - Active tables: ${activeTables.length}`);
      if (activeTables.length > 0) {
        activeTables.forEach(table => {
          console.log(`     • Table ${table.table_number}: capacity ${table.capacity || 'unlimited'}`);
        });
      }
    });
    
    // Test for 2 people
    console.log('\n' + '='.repeat(60));
    console.log('🎯 Testing: Available zones for 2 people\n');
    
    const zonesMapFor2 = await ReservationService.getAvailableZonesWithTables(
      business.id,
      2
    );
    
    const availableZonesFor2 = Array.from(zonesMapFor2.keys());
    
    console.log(`\n✅ Result: ${availableZonesFor2.length} zone(s) available`);
    if (availableZonesFor2.length > 0) {
      console.log('\nAvailable zones:');
      availableZonesFor2.forEach((zoneName, idx) => {
        const zoneData = zonesMapFor2.get(zoneName);
        console.log(`   ${idx + 1}. ${zoneName} (${zoneData?.tables.length} tables)`);
      });
      
      // Simulate the message that would be sent
      console.log('\n📨 Message that should be sent to user:\n');
      if (availableZonesFor2.length === 1) {
        console.log(`   "Genial! Tenemos disponible la zona **${availableZonesFor2[0]}**. ¿Confirmas esta zona?"`);
      } else {
        const zonesFormatted = availableZonesFor2
          .map((zone, idx) => `${idx + 1}. ${zone}`)
          .join('\n   ');
        console.log(`   "Perfecto! Tenemos las siguientes zonas disponibles:\n\n   ${zonesFormatted}\n\n   ¿Qué zona prefieres?"`);
      }
    } else {
      console.log('\n⚠️  No zones available for 2 people');
      console.log('\nPossible reasons:');
      console.log('   - No active tables in any zone');
      console.log('   - All tables have capacity < 2');
      console.log('   - Tables not properly configured');
    }
    
    // Test for 4 people
    console.log('\n' + '='.repeat(60));
    console.log('🎯 Testing: Available zones for 4 people\n');
    
    const zonesMapFor4 = await ReservationService.getAvailableZonesWithTables(
      business.id,
      4
    );
    
    const availableZonesFor4 = Array.from(zonesMapFor4.keys());
    console.log(`✅ Result: ${availableZonesFor4.length} zone(s) available for 4 people`);
    if (availableZonesFor4.length > 0) {
      availableZonesFor4.forEach((zoneName, idx) => {
        console.log(`   ${idx + 1}. ${zoneName}`);
      });
    }
    
    console.log('\n' + '='.repeat(60) + '\n');
    
  } catch (error) {
    console.error('❌ Error:', error);
  }
}

// Run test
testZonesAvailability()
  .then(() => {
    console.log('✅ Test completed\n');
    process.exit(0);
  })
  .catch((error) => {
    console.error('❌ Test failed:', error);
    process.exit(1);
  });
