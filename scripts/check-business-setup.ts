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

    // Get tables
    console.log('\n🪑 Fetching tables...');
    const tables = await SupabaseService.getActiveTablesByBusiness(BUSINESS_ID);
    console.log(`✅ Found ${tables.length} tables:`);

    const availableTables = tables.filter((table) => !table.is_occupied);
    console.log(`✅ Available (not occupied): ${availableTables.length}`);

    // Group tables by capacity
    const tablesByCapacity = new Map<string, typeof tables>();
    tables.forEach(table => {
      const capacity = table.capacity ?? 0;
      const bucket = capacity >= 8 ? '8+' : String(capacity);
      if (!tablesByCapacity.has(bucket)) {
        tablesByCapacity.set(bucket, []);
      }
      tablesByCapacity.get(bucket)!.push(table);
    });

    console.log('\n📊 Tables by capacity:');
    tablesByCapacity.forEach((groupTables, capacity) => {
      console.log(`\n   Capacity ${capacity}: ${groupTables.length} table(s)`);
      groupTables.forEach(table => {
        console.log(`      - Table ${table.table_number}: Capacity ${table.capacity}, Active: ${table.is_active}`);
      });
    });

    // Test table matching by party size
    console.log('\n🧪 Testing table availability for different party sizes...');
    const testSizes = [2, 4, 6, 8];
    for (const size of testSizes) {
      const fittingTables = availableTables.filter((table) => {
        if (table.capacity === null) {
          return true;
        }
        return table.capacity >= size;
      });
      console.log(`   Party size ${size}: ${fittingTables.length} table(s) compatibles`);
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
