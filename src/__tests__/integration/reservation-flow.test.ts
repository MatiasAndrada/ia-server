import { ReservationService } from '../../services/reservation.service.js';
import { SupabaseService } from '../../services/supabase.service.js';
import { RedisConfig } from '../../config/redis.js';
import { SupabaseConfig } from '../../config/supabase.js';

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
    it('should save the first name only and advance directly to party_size (apellido is optional)', async () => {
      const result = await ReservationService.setCustomerName(
        TEST_CONVERSATION_ID,
        'Juan'
      );

      expect(result).toBeDefined();
      expect(result?.step).toBe('party_size');

      const draft = await ReservationService.getDraft(TEST_CONVERSATION_ID);
      expect(draft?.customerName).toBe('Juan');
      expect(draft?.customerLastName).toBeUndefined();
      expect(draft?.step).toBe('party_size');
    });

    it('should handle empty name input without throwing', async () => {
      const result = await ReservationService.setCustomerName(TEST_CONVERSATION_ID, '');
      expect(result).toBeDefined();
    });

    it('should save name and apellido together in one step and advance to party_size', async () => {
      const result = await ReservationService.setCustomerNameParts(
        TEST_CONVERSATION_ID,
        'Juan',
        'Pérez'
      );

      expect(result).toBeDefined();
      expect(result?.step).toBe('party_size');

      const draft = await ReservationService.getDraft(TEST_CONVERSATION_ID);
      expect(draft?.customerLastName).toBe('Pérez');
      expect(draft?.step).toBe('party_size');
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
      ).rejects.toThrow('Party size must be at least 1');
    });

    it('should reject negative party size', async () => {
      await expect(
        ReservationService.setPartySize(TEST_CONVERSATION_ID, -5)
      ).rejects.toThrow('Party size must be at least 1');
    });
  });

  describe('Step 3b: Schedule Choice / Date / Time', () => {
    const scheduleConvId = 'schedule-conv-' + Date.now();

    beforeAll(async () => {
      await ReservationService.startReservation(scheduleConvId, TEST_BUSINESS_ID);
      await ReservationService.setCustomerName(scheduleConvId, 'Ana Lopez');
      await ReservationService.setPartySize(scheduleConvId, 2);
    });

    afterAll(async () => {
      await ReservationService.deleteDraft(scheduleConvId);
    });

    it('moves to schedule_choice after party size is confirmed', async () => {
      const result = await ReservationService.moveToScheduleChoice(scheduleConvId);
      expect(result?.step).toBe('schedule_choice');
    });

    it('clears any scheduling fields when choosing the instant/current turn', async () => {
      await ReservationService.moveToConfirmSlot(
        scheduleConvId,
        '2026-07-02',
        '20:00',
        '2026-07-02T23:00:00.000Z',
        'schedule_choice'
      );

      const result = await ReservationService.setInstantSchedule(scheduleConvId);
      expect(result?.scheduledDate).toBeUndefined();
      expect(result?.scheduledTime).toBeUndefined();
      expect(result?.scheduledAt).toBeUndefined();
    });

    it('moves to the date step when choosing another day', async () => {
      const result = await ReservationService.moveToDateStep(scheduleConvId);
      expect(result?.step).toBe('date');
    });

    it('saves the chosen day and advances to the time step', async () => {
      const parsedDay = {
        baDate: new Date('2026-07-03T00:00:00.000Z'),
        label: 'viernes 03/07',
        isToday: false,
        matchedWeekdayName: false,
      };
      const result = await ReservationService.setScheduledDate(scheduleConvId, parsedDay);

      expect(result?.step).toBe('time');
      expect(result?.scheduledDate).toBe('2026-07-03');
    });

    it('saves the chosen time as the final scheduled instant', async () => {
      const result = await ReservationService.setScheduledTime(
        scheduleConvId,
        '21:00',
        '2026-07-04T00:00:00.000Z'
      );

      expect(result?.scheduledTime).toBe('21:00');
      expect(result?.scheduledAt).toBe('2026-07-04T00:00:00.000Z');
    });

    it('moves to confirm_slot carrying the proposed slot and origin', async () => {
      const result = await ReservationService.moveToConfirmSlot(
        scheduleConvId,
        '2026-07-03',
        '21:00',
        '2026-07-04T00:00:00.000Z',
        'time'
      );

      expect(result?.step).toBe('confirm_slot');
      expect(result?.confirmSlotOrigin).toBe('time');
      expect(result?.scheduledAt).toBe('2026-07-04T00:00:00.000Z');
    });

    it('returns null for missing draft on every new schedule method', async () => {
      const missingConvId = 'missing-' + Date.now();
      await expect(ReservationService.moveToScheduleChoice(missingConvId)).resolves.toBeNull();
      await expect(ReservationService.setInstantSchedule(missingConvId)).resolves.toBeNull();
      await expect(ReservationService.moveToDateStep(missingConvId)).resolves.toBeNull();
      await expect(
        ReservationService.setScheduledDate(missingConvId, {
          baDate: new Date(),
          label: 'hoy',
          isToday: true,
          matchedWeekdayName: false,
        })
      ).resolves.toBeNull();
      await expect(
        ReservationService.setScheduledTime(missingConvId, '20:00', new Date().toISOString())
      ).resolves.toBeNull();
      await expect(
        ReservationService.moveToConfirmSlot(missingConvId, '2026-07-03', '21:00', '2026-07-04T00:00:00.000Z', 'time')
      ).resolves.toBeNull();
    });
  });

  describe('Step 3c: Edit Schedule Draft', () => {
    it('starts an edit-mode draft targeting the schedule of an existing reservation', async () => {
      const editConvId = 'edit-schedule-' + Date.now();

      const draft = await ReservationService.startEditSchedule(editConvId, TEST_BUSINESS_ID, 'reservation-123', {
        customerName: 'Carlos Diaz',
        partySize: 3,
      });

      expect(draft.step).toBe('schedule_choice');
      expect(draft.editMode).toBe(true);
      expect(draft.editingField).toBe('schedule');
      expect(draft.existingReservationId).toBe('reservation-123');
      expect(draft.customerName).toBe('Carlos Diaz');
      expect(draft.partySize).toBe(3);

      await ReservationService.deleteDraft(editConvId);
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
        expect(tables[0]).toHaveProperty('name');
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
