import { agentService } from '../src/services/agent.service';
import { agentRegistry } from '../src/agents';
import { SupabaseConfig } from '../src/config/supabase';
import { SupabaseService } from '../src/services/supabase.service';
import * as dotenv from 'dotenv';

dotenv.config();

const BUSINESS_ID = '8361f000-d50c-4c9c-b5d7-1b9fd3b60838';
const TEST_PHONE = '5493532401540';
const CONVERSATION_ID = `${BUSINESS_ID}-${TEST_PHONE}`;

async function simulateReservationFlow() {
  try {
    console.log('\n🎭 Simulating Agent Response with Table Availability Context\n');
    console.log('='.repeat(70));
    
    // Initialize
    SupabaseConfig.initialize();
    const agent = agentRegistry.get('waitlist');
    
    if (!agent) {
      console.error('❌ Waitlist agent not found');
      return;
    }
    
    // Step: User provides party size - THE CRITICAL STEP
    console.log('\n📱 User message: "2" (for party size)');

    // Get available tables for a party of 2
    console.log('\n🔍 Fetching active tables from database...');
    const activeTables = await SupabaseService.getTablesByBusiness(BUSINESS_ID);
    const availableTables = activeTables.filter((table) => {
      if (table.capacity === null) {
        return true;
      }
      return table.capacity >= 2;
    });

    console.log(`\n📊 Database returned ${availableTables.length} compatible tables`);
    console.log(`📋 Tables: ${availableTables.map((table) => table.table_number).join(', ')}`);
    
    // Generate agent response with table-availability context
    console.log('\n🤖 Calling agent with proper context...');
    const response = await agentService.generateResponse(
      '2',
      agent,
      CONVERSATION_ID,
      { 
        businessName: 'Restaurante del centro',
        currentStep: 'party_size',
        draftData: { 
          customerName: 'Matias Andrada',
          partySize: 2
        },
        availableTablesCount: availableTables.length,
        availableTables: availableTables.map((table) => ({
          tableNumber: table.table_number,
          capacity: table.capacity,
        }))
      }
    );
    
    console.log('\n' + '='.repeat(70));
    console.log('🎯 AGENT RESPONSE (what user would receive):\n');
    console.log(response.response);
    console.log('\n' + '='.repeat(70));
    
    // Show what a table-oriented response could look like
    console.log('\n📨 TABLE-ORIENTED MESSAGE EXAMPLE:\n');
    if (availableTables.length > 0) {
      console.log(`Tenemos ${availableTables.length} mesa(s) disponible(s) para 2 personas.`);
    } else {
      console.log('Por ahora no hay mesas activas disponibles para 2 personas.');
    }
    
    console.log('\n' + '='.repeat(70));
    console.log('\n💡 ANALYSIS:\n');
    console.log(`   - Database has ${availableTables.length} compatible tables`);
    console.log(`   - Agent received context with table availability`);
    console.log(`   - Custom table-aware message can be sent when needed`);
    console.log(`   - The handler should return TRUE to skip agent response\n`);
    
  } catch (error) {
    console.error('❌ Error:', error);
  }
}

simulateReservationFlow()
  .then(() => {
    console.log('✅ Simulation complete\\n');
    process.exit(0);
  })
  .catch(error => {
    console.error('❌ Simulation failed:', error);
    process.exit(1);
  });
