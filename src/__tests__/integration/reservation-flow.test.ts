import { ReservationService } from '../../services/reservation.service';
import { SupabaseService } from '../../services/supabase.service';
import { RedisConfig } from '../../config/redis';
import { SupabaseConfig } from '../../config/supabase';

describe('Reservation Flow Integration Tests', () => {
  let reservationService: ReservationService;
  let supabaseService: SupabaseService;
  
  const TEST_BUSINESS_ID = process.env.TEST_BUSINESS_ID || 'test-business-id';
  const TEST_CONVERSATION_ID = 'test-conv-' + Date.now();

  beforeAll(async () => {
    await RedisConfig.initialize();
    await SupabaseConfig.initialize();
    
    reservationService = new ReservationService();
    supabaseService = new SupabaseService();
  });

  afterAll(async () => {
    // Clean up test drafts
    await reservationService.deleteDraft(TEST_CONVERSATION_ID);
    await RedisConfig.close();
  });

  describe('Step 1: Start Reservation', () => {
    it('should initialize reservation draft with name step', async () => {
      await reservationService.startReservation(TEST_CONVERSATION_ID, TEST_BUSINESS_ID);
      
      const draft = await reservationService.getDraft(TEST_CONVERSATION_ID);
      
      expect(draft).toBeDefined();
      expect(draft?.businessId).toBe(TEST_BUSINESS_ID);
      expect(draft?.step).toBe('name');
      expect(draft?.customerName).toBeUndefined();
    });

    it('should not allow starting if draft already exists', async () => {
      await expect(
        reservationService.startReservation(TEST_CONVERSATION_ID, TEST_BUSINESS_ID)
      ).rejects.toThrow('Reservation draft already exists');
    });
  });

  describe('Step 2: Collect Customer Name', () => {
    it('should save customer name and advance to party size', async () => {
      const result = await reservationService.setCustomerName(
        TEST_CONVERSATION_ID,
        'Juan Pérez'
      );

      expect(result).toBe(true);

      const draft = await reservationService.getDraft(TEST_CONVERSATION_ID);
      expect(draft?.customerName).toBe('Juan Pérez');
      expect(draft?.step).toBe('party_size');
    });

    it('should reject empty name', async () => {
      await expect(
        reservationService.setCustomerName(TEST_CONVERSATION_ID, '')
      ).rejects.toThrow();
    });
  });

  describe('Step 3: Collect Party Size', () => {
    it('should save party size and advance to zone selection', async () => {
      const result = await reservationService.setPartySize(
        TEST_CONVERSATION_ID,
        4
      );

      expect(result).toBe(true);

      const draft = await reservationService.getDraft(TEST_CONVERSATION_ID);
      expect(draft?.partySize).toBe(4);
      expect(draft?.step).toBe('zone_selection');
    });

    it('should reject invalid party size', async () => {
      await expect(
        reservationService.setPartySize(TEST_CONVERSATION_ID, 0)
      ).rejects.toThrow('Invalid party size');
    });

    it('should reject negative party size', async () => {
      await expect(
        reservationService.setPartySize(TEST_CONVERSATION_ID, -5)
      ).rejects.toThrow('Invalid party size');
    });
  });

  describe('Step 4: Get Available Zones', () => {
    it('should fetch zones from Supabase', async () => {
      const zones = await reservationService.getAvailableZones(TEST_BUSINESS_ID);

      expect(Array.isArray(zones)).toBe(true);
      
      if (zones.length > 0) {
        expect(typeof zones[0]).toBe('string');
      }
    });
  });

  describe('Step 5: Select Zone', () => {
    it('should save zone selection and advance to confirmation', async () => {
      // First, get available zones
      const zones = await reservationService.getAvailableZones(TEST_BUSINESS_ID);
      
      if (zones.length === 0) {
        console.warn('⚠️ No zones available in test business. Skipping zone selection test.');
        return;
      }

      const selectedZone = zones[0];
      
      const result = await reservationService.selectZone(
        TEST_CONVERSATION_ID,
        selectedZone
      );

      expect(result).toBe(true);

      const draft = await reservationService.getDraft(TEST_CONVERSATION_ID);
      expect(draft?.zone).toBe(selectedZone);
      expect(draft?.step).toBe('confirmation');
    });

    it('should reject non-existent zone', async () => {
      await expect(
        reservationService.selectZone(TEST_CONVERSATION_ID, 'NonExistentZone')
      ).rejects.toThrow('Invalid zone');
    });
  });

  describe('Step 6: Create Reservation', () => {
    it('should create waitlist entry in Supabase', async () => {
      // Skip if no zones available
      const zones = await reservationService.getAvailableZones(TEST_BUSINESS_ID);
      if (zones.length === 0) {
        console.warn('⚠️ No zones available. Skipping reservation creation test.');
        return;
      }

      const draft = await reservationService.getDraft(TEST_CONVERSATION_ID);
      
      if (!draft || draft.step !== 'confirmation') {
        console.warn('⚠️ Draft not in confirmation state. Skipping creation test.');
        return;
      }

      const waitlistEntry = await reservationService.createReservation(
        TEST_CONVERSATION_ID,
        '+1234567890'
      );

      expect(waitlistEntry).toBeDefined();
      expect(waitlistEntry.business_id).toBe(TEST_BUSINESS_ID);
      expect(waitlistEntry.party_size).toBe(draft.partySize);
      expect(waitlistEntry.status).toBe('WAITING');
      expect(waitlistEntry.display_code).toBeDefined();

      // Verify draft is deleted after creation
      const draftAfter = await reservationService.getDraft(TEST_CONVERSATION_ID);
      expect(draftAfter).toBeNull();
    });
  });

  describe('Draft Management', () => {
    const tempConvId = 'temp-conv-' + Date.now();

    it('should delete draft manually', async () => {
      await reservationService.startReservation(tempConvId, TEST_BUSINESS_ID);
      
      let draft = await reservationService.getDraft(tempConvId);
      expect(draft).toBeDefined();

      await reservationService.deleteDraft(tempConvId);
      
      draft = await reservationService.getDraft(tempConvId);
      expect(draft).toBeNull();
    });

    it('should return null for non-existent draft', async () => {
      const draft = await reservationService.getDraft('non-existent-id');
      expect(draft).toBeNull();
    });
  });

  describe('Supabase Integration', () => {
    it('should fetch tables by business', async () => {
      const tables = await supabaseService.getTablesByBusiness(TEST_BUSINESS_ID);
      
      expect(Array.isArray(tables)).toBe(true);
      
      if (tables.length > 0) {
        expect(tables[0]).toHaveProperty('id');
        expect(tables[0]).toHaveProperty('table_number');
        expect(tables[0]).toHaveProperty('capacity');
        expect(tables[0]).toHaveProperty('zone_id');
      }
    });

    it('should fetch zones by business', async () => {
      const zones = await supabaseService.getZonesByBusiness(TEST_BUSINESS_ID);
      
      expect(Array.isArray(zones)).toBe(true);
      
      if (zones.length > 0) {
        expect(zones[0]).toHaveProperty('id');
        expect(zones[0]).toHaveProperty('name');
        expect(typeof zones[0].name).toBe('string');
      }
    });

    it('should get or create customer', async () => {
      const phone = '+1234567890';
      const name = 'Test Customer';

      const customer = await supabaseService.getOrCreateCustomer(name, phone, TEST_BUSINESS_ID);

      expect(customer).toHaveProperty('id');
      expect(customer.phone).toBe(phone);
      expect(customer.name).toBe(name);
      expect(customer.business_id).toBe(TEST_BUSINESS_ID);
    });
  });

  describe('Error Scenarios', () => {
    it('should handle missing draft gracefully', async () => {
      await expect(
        reservationService.setCustomerName('non-existent-id', 'Test')
      ).rejects.toThrow('No active reservation draft');
    });

    it('should handle out-of-order steps', async () => {
      const convId = 'out-of-order-' + Date.now();
      await reservationService.startReservation(convId, TEST_BUSINESS_ID);

      // Try to skip directly to zone selection without name and party size
      await expect(
        reservationService.selectZone(convId, 'any-zone')
      ).rejects.toThrow();

      await reservationService.deleteDraft(convId);
    });
  });
});
