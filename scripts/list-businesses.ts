import { SupabaseConfig } from '../src/config/supabase';
import * as dotenv from 'dotenv';

dotenv.config();

async function listBusinesses() {
  try {
    console.log('\n📋 Listing all businesses in database...\n');
    
    // Initialize Supabase
    SupabaseConfig.initialize();
    
    if (!SupabaseConfig.isReady()) {
      console.error('❌ Supabase not initialized');
      return;
    }
    
    const supabase = SupabaseConfig.getClient();
    
    // Get all businesses
    const { data: businesses, error } = await supabase
      .from('businesses')
      .select('id, name, whatsapp_phone_number')
      .order('created_at', { ascending: false });
    
    if (error) {
      console.error('❌ Error:', error.message);
      return;
    }
    
    if (!businesses || businesses.length === 0) {
      console.log('⚠️  No businesses found in database\n');
      return;
    }
    
    console.log(`✅ Found ${businesses.length} business(es):\n`);
    businesses.forEach((biz, idx) => {
      console.log(`${idx + 1}. ${biz.name}`);
      console.log(`   ID: ${biz.id}`);
      console.log(`   WhatsApp: ${biz.whatsapp_phone_number || 'Not configured'}`);
      console.log('');
    });
    
    console.log('\n💡 To test reservations/tables, update .env with the correct TEST_BUSINESS_ID\n');
    
  } catch (error: any) {
    console.error('❌ Error:', error.message);
  }
}

listBusinesses()
  .then(() => process.exit(0))
  .catch(error => {
    console.error('❌ Failed:', error);
    process.exit(1); 
  });
