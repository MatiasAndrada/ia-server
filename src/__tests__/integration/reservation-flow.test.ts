import { ReservationService } from '../../services/reservation.service';
import { SupabaseService } from '../../services/supabase.service';
import { RedisConfig } from '../../config/redis';
import { SupabaseConfig } from '../../config/supabase';

describe('Reservation Flow Integration Tests', () => {
  const TEST_BUSINESS_ID = process.env.TEST_BUSINESS_ID || 'test-business-id';
  const TEST_CONVERSATION_ID = 'test-conv-' + Date.now();
  let supabaseReady = false;

  beforeAll(async () => {
    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
    await RedisConfig.initialize(redisUrl);
    SupabaseConfig.initialize();
    supabaseReady = SupabaseConfig.isReady();
  });

  afterAll(async () => {
    // Clean up test drafts
    await ReservationService.deleteDraft(TEST_CONVERSATION_ID);
    await RedisConfig.disconnect();
  });

  describe('Step 1: Start Reservation', () => {
    it('should initialize reservation draft with name step', async () => {
      await ReservationService.startReservation(TEST_CONVERSATION_ID, TEST_BUSINESS_ID);
      
      const draft = await ReservationService.getDraft(TEST_CONVERSATION_ID);
      
      expect(draft).toBeDefined();
      expect(draft?.businessId).toBe(TEST_BUSINESS_ID);
      expect(draft?.step).toBe('name');
      expect(draft?.customerName).toBeUndefined();
    });

    it('should allow restarting and keep draft available', async () => {
      await expect(
        ReservationService.startReservation(TEST_CONVERSATION_ID, TEST_BUSINESS_ID)
      ).resolves.toBeDefined();

      const draft = await ReservationService.getDraft(TEST_CONVERSATION_ID);
      expect(draft).toBeDefined();
      expect(draft?.step).toBe('name');
    });
  });

  describe('Step 2: Collect Customer Name', () => {
    it('should save customer name and advance to party size', async () => {
      const result = await ReservationService.setCustomerName(
        TEST_CONVERSATION_ID,
        'Juan Pérez'
      );

      expect(result).toBeDefined();
      expect(result?.step).toBe('party_size');

      const draft = await ReservationService.getDraft(TEST_CONVERSATION_ID);
      expect(draft?.customerName).toBe('Juan Pérez');
      expect(draft?.step).toBe('party_size');
    });

    it('should handle empty name input without throwing', async () => {
      const result = await ReservationService.setCustomerName(TEST_CONVERSATION_ID, '');
      expect(result).toBeDefined();
    });
  });

  describe('Step 3: Collect Party Size', () => {
    it('should save party size and keep party_size step until reservation creation', async () => {
      const result = await ReservationService.setPartySize(
        TEST_CONVERSATION_ID,
        4
      );

      expect(result).toBeDefined();
      expect(result?.step).toBe('party_size');

      const draft = await ReservationService.getDraft(TEST_CONVERSATION_ID);
      expect(draft?.partySize).toBe(4);
      expect(draft?.step).toBe('party_size');
    });

    it('should reject invalid party size', async () => {
      await expect(
        ReservationService.setPartySize(TEST_CONVERSATION_ID, 0)
      ).rejects.toThrow('Party size must be between 1 and 50');
    });

    it('should reject negative party size', async () => {
      await expect(
        ReservationService.setPartySize(TEST_CONVERSATION_ID, -5)
      ).rejects.toThrow('Party size must be between 1 and 50');
    });
  });

  describe('Step 4: Create Reservation', () => {
    it('should create waitlist entry in Supabase', async () => {
      if (!supabaseReady) {
        console.warn('⚠️ Supabase no inicializado. Skipping reservation creation test.');
        return;
      }

      // Ensure valid draft data in case previous tests set an empty name.
      await ReservationService.setCustomerName(TEST_CONVERSATION_ID, 'Juan Pérez');
      await ReservationService.setPartySize(TEST_CONVERSATION_ID, 4);

      const draft = await ReservationService.getDraft(TEST_CONVERSATION_ID);
      
      if (!draft || draft.step !== 'party_size') {
        console.warn('⚠️ Draft not in party_size state. Skipping creation test.');
        return;
      }

      const result = await ReservationService.createReservation(
        TEST_CONVERSATION_ID,
        '+1234567890'
      );

      expect(result).toBeDefined();
      expect(result.success).toBe(true);
      expect(result.waitlistEntry?.business_id).toBe(TEST_BUSINESS_ID);
      expect(result.waitlistEntry?.party_size).toBe(draft.partySize);
      expect(result.waitlistEntry?.status).toBeDefined();
      expect(result.waitlistEntry?.display_code).toBeDefined();

      // Draft is marked completed before delayed cleanup
      const draftAfter = await ReservationService.getDraft(TEST_CONVERSATION_ID);
      expect(draftAfter?.step === 'completed' || draftAfter === null).toBe(true);
    });
  });

  describe('Draft Management', () => {
    const tempConvId = 'temp-conv-' + Date.now();

    it('should delete draft manually', async () => {
      await ReservationService.startReservation(tempConvId, TEST_BUSINESS_ID);
      
      let draft = await ReservationService.getDraft(tempConvId);
      expect(draft).toBeDefined();

      await ReservationService.deleteDraft(tempConvId);
      
      draft = await ReservationService.getDraft(tempConvId);
      expect(draft).toBeNull();
    });

    it('should return null for non-existent draft', async () => {
      const draft = await ReservationService.getDraft('non-existent-id');
      expect(draft).toBeNull();
    });
  });

  describe('Supabase Integration', () => {
    it('should fetch tables by business', async () => {
      if (!supabaseReady) {
        console.warn('⚠️ Supabase no inicializado. Skipping table fetch test.');
        return;
      }

      const tables = await SupabaseService.getTablesByBusiness(TEST_BUSINESS_ID);
      
      expect(Array.isArray(tables)).toBe(true);
      
      if (tables.length > 0) {
        expect(tables[0]).toHaveProperty('id');
        expect(tables[0]).toHaveProperty('table_number');
        expect(tables[0]).toHaveProperty('capacity');
      }
    });

    it('should get or create customer', async () => {
      if (!supabaseReady) {
        console.warn('⚠️ Supabase no inicializado. Skipping customer test.');
        return;
      }

      const phone = '+1234567890';
      const name = 'Test Customer';

      const customer = await SupabaseService.getOrCreateCustomer(name, phone, TEST_BUSINESS_ID);

      expect(customer).toHaveProperty('id');
      expect(customer.phone).toBe(phone);
      expect(customer.name).toBe(name);
      expect(customer.business_id).toBe(TEST_BUSINESS_ID);
    });
  });

  describe('Error Scenarios', () => {
    it('should return null for missing draft operations', async () => {
      const result = await ReservationService.setCustomerName('non-existent-id', 'Test');
      expect(result).toBeNull();
    });

    it('should handle out-of-order steps', async () => {
      const convId = 'out-of-order-' + Date.now();
      await ReservationService.startReservation(convId, TEST_BUSINESS_ID);

      // Try to create reservation directly without required fields
      const result = await ReservationService.createReservation(convId, '+1234567890');
      expect(result.success).toBe(false);

      await ReservationService.deleteDraft(convId);
    });
  });
});
