import { WhatsAppHandler } from '../../services/whatsapp-handler.service';
import { SupabaseService } from '../../services/supabase.service';
import { ReservationService } from '../../services/reservation.service';
import { agentService } from '../../services/agent.service';
import { agentRegistry } from '../../agents';
import * as ReservationDatetime from '../../utils/reservation-datetime';

jest.mock('../../utils/logger');

describe('WhatsAppHandler single-active-reservation policy', () => {
  let handler: WhatsAppHandler;
  let mockBaileysService: {
    sendMessage: jest.Mock<Promise<boolean>, [string, string, string]>;
    getSelfJid: jest.Mock<string | undefined, [string]>;
  };

  beforeEach(() => {
    jest.clearAllMocks();

    mockBaileysService = {
      sendMessage: jest.fn().mockResolvedValue(true),
      getSelfJid: jest.fn().mockReturnValue(''),
    };

    handler = new WhatsAppHandler(mockBaileysService as any);
  });

  it('blocks explicit new reservation intent when there is an active reservation', async () => {
    jest
      .spyOn(SupabaseService, 'getActiveReservationByPhone')
      .mockResolvedValue({
        id: 'entry-1',
        status: 'CONFIRMED',
        display_code: 'A123',
      } as any);

    const handled = await (handler as any).enforceSingleActiveReservationPolicy(
      'business-1',
      '5491111111111@s.whatsapp.net',
      'quiero hacer otra reserva',
      'conv-1'
    );

    expect(handled).toBe(true);
    expect(mockBaileysService.sendMessage).toHaveBeenCalledTimes(1);
    expect(mockBaileysService.sendMessage).toHaveBeenCalledWith(
      'business-1',
      '5491111111111@s.whatsapp.net',
      expect.stringContaining('ya tenés una reserva para hoy')
    );
  });

  it('does not block when there is no active reservation', async () => {
    jest
      .spyOn(SupabaseService, 'getActiveReservationByPhone')
      .mockResolvedValue(null);

    const handled = await (handler as any).enforceSingleActiveReservationPolicy(
      'business-1',
      '5491111111111@s.whatsapp.net',
      'quiero reservar una mesa para 4',
      'conv-2'
    );

    expect(handled).toBe(false);
    expect(mockBaileysService.sendMessage).not.toHaveBeenCalled();
  });

  it('does not block unrelated messages even if there is an active reservation', async () => {
    jest
      .spyOn(SupabaseService, 'getActiveReservationByPhone')
      .mockResolvedValue({
        id: 'entry-2',
        status: 'WAITING',
        display_code: 'B777',
      } as any);

    const handled = await (handler as any).enforceSingleActiveReservationPolicy(
      'business-1',
      '5491111111111@s.whatsapp.net',
      'gracias',
      'conv-3'
    );

    expect(handled).toBe(false);
    expect(mockBaileysService.sendMessage).not.toHaveBeenCalled();
  });

  it('prevents CREATE_RESERVATION action from starting a draft when active reservation exists', async () => {
    jest
      .spyOn(SupabaseService, 'getActiveReservationByPhone')
      .mockResolvedValue({
        id: 'entry-3',
        status: 'NOTIFIED',
        display_code: 'C999',
      } as any);

    const startReservationSpy = jest
      .spyOn(ReservationService, 'startReservation')
      .mockResolvedValue({
        conversationId: 'conv-4',
        businessId: 'business-1',
        step: 'name',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

    await (handler as any).handleCreateReservation(
      'conv-4',
      'business-1',
      '5492222222222@s.whatsapp.net'
    );

    expect(startReservationSpy).not.toHaveBeenCalled();
    expect(mockBaileysService.sendMessage).toHaveBeenCalledTimes(1);
    expect(mockBaileysService.sendMessage).toHaveBeenCalledWith(
      'business-1',
      '5492222222222@s.whatsapp.net',
      expect.stringContaining('No puedo crear una nueva')
    );
  });

  it('starts reservation draft when CREATE_RESERVATION is requested and no active reservation exists', async () => {
    jest
      .spyOn(SupabaseService, 'getActiveReservationByPhone')
      .mockResolvedValue(null);

    const startReservationSpy = jest
      .spyOn(ReservationService, 'startReservation')
      .mockResolvedValue({
        conversationId: 'conv-5',
        businessId: 'business-1',
        step: 'name',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

    await (handler as any).handleCreateReservation(
      'conv-5',
      'business-1',
      '5493333333333@s.whatsapp.net'
    );

    expect(startReservationSpy).toHaveBeenCalledTimes(1);
    expect(startReservationSpy).toHaveBeenCalledWith('conv-5', 'business-1');
  });

  it('greeting with active reservation includes reminder that new reservations are blocked', async () => {
    jest
      .spyOn(ReservationService, 'getDraft')
      .mockResolvedValue(null);

    jest
      .spyOn(agentService, 'clearConversationHistory')
      .mockResolvedValue(undefined);

    jest
      .spyOn(SupabaseService, 'getActiveReservationByPhone')
      .mockResolvedValue({
        id: 'entry-6',
        party_size: 2,
        display_code: 'R212',
        status: 'CONFIRMED',
      } as any);

    const startEditMenuSpy = jest
      .spyOn(ReservationService, 'startEditMenu')
      .mockResolvedValue({
        conversationId: 'conv-6',
        businessId: 'business-1',
        step: 'edit_menu',
        editMode: true,
        existingReservationId: 'entry-6',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      } as any);

    const handled = await (handler as any).handleGreeting(
      'hola',
      'business-1',
      '5494444444444@s.whatsapp.net',
      'conv-6'
    );

    expect(handled).toBe(true);
    expect(startEditMenuSpy).toHaveBeenCalledTimes(1);
    expect(mockBaileysService.sendMessage).toHaveBeenCalledWith(
      'business-1',
      '5494444444444@s.whatsapp.net',
      expect.stringContaining('¿Qué querés modificar?')
    );
  });

  it('multi-turn flow: block new reservation, cancel active one, then allow new reservation', async () => {
    jest
      .spyOn(agentRegistry, 'get')
      .mockReturnValue({
        id: 'waitlist',
        name: 'Asistente de Reservas',
        description: 'Test agent',
        model: 'llama3.2',
        temperature: 0.2,
        maxTokens: 250,
        enabled: true,
        systemPrompt: 'test',
        actions: [],
      } as any);

    // Stateful draft: the M3 cancel flow spans several turns (cancel_menu →
    // cancel_confirm), so getDraft must reflect what startCancelMenu/saveDraft set.
    let currentDraft: any = null;
    jest.spyOn(ReservationService, 'getDraft').mockImplementation(async () => currentDraft);
    jest
      .spyOn(ReservationService, 'startCancelMenu')
      .mockImplementation(async (conversationId, businessId, reservationId, data: any) => {
        currentDraft = {
          conversationId,
          businessId,
          step: 'cancel_menu',
          editMode: true,
          existingReservationId: reservationId,
          ...data,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        return currentDraft;
      });
    jest.spyOn(ReservationService, 'saveDraft').mockImplementation(async (d: any) => {
      currentDraft = d;
      return true;
    });
    jest.spyOn(ReservationService, 'deleteDraft').mockImplementation(async () => {
      currentDraft = null;
      return true;
    });

    jest
      .spyOn(SupabaseService, 'isBusinessWhatsAppActive')
      .mockResolvedValue(true);

    jest
      .spyOn(SupabaseService, 'getBusinessById')
      .mockResolvedValue({
        id: 'business-1',
        name: 'Restaurante Test',
        whatsapp_session_id: 'session-test-1',
      } as any);

    const activeReservation = {
      id: 'entry-7',
      status: 'CONFIRMED',
      display_code: 'Q111',
      party_size: 3,
    } as any;

    const getActiveSpy = jest
      .spyOn(SupabaseService, 'getActiveReservationByPhone')
      .mockResolvedValueOnce(activeReservation) // policy block on first message
      .mockResolvedValueOnce(activeReservation) // cancel path on second message (M3 menu)
      .mockResolvedValueOnce(null) // policy check on final message
      .mockResolvedValueOnce(null); // handleCreateReservation safety check

    const cancelSpy = jest
      .spyOn(SupabaseService, 'updateReservationStatus')
      .mockResolvedValue(true);

    jest
      .spyOn(agentService, 'getConversationHistory')
      .mockResolvedValue([] as any);

    jest
      .spyOn(agentService, 'generateResponse')
      .mockResolvedValue({
        response: 'Perfecto, ¿cuál es tu nombre?',
        action: 'CREATE_RESERVATION',
        conversationId: 'business-1-5495555555555',
        agent: { id: 'waitlist', name: 'Asistente de Reservas' },
        processingTime: 10,
      } as any);

    const startReservationSpy = jest
      .spyOn(ReservationService, 'startReservation')
      .mockResolvedValue({
        conversationId: 'business-1-5495555555555',
        businessId: 'business-1',
        step: 'name',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

    await (handler as any)._processMessage({
      from: '5495555555555@s.whatsapp.net',
      businessId: 'business-1',
      message: 'quiero hacer otra reserva',
      fromMe: false,
    });

    // M3: cancellation now opens a menu (reprogramar / cancelar definitivamente)
    await (handler as any)._processMessage({
      from: '5495555555555@s.whatsapp.net',
      businessId: 'business-1',
      message: 'cancelar mi reserva',
      fromMe: false,
    });

    // Choose "cancelar definitivamente" → asks for confirmation
    await (handler as any)._processMessage({
      from: '5495555555555@s.whatsapp.net',
      businessId: 'business-1',
      message: '2',
      fromMe: false,
    });

    // Confirm "sí, cancelar" → reservation is actually cancelled
    await (handler as any)._processMessage({
      from: '5495555555555@s.whatsapp.net',
      businessId: 'business-1',
      message: '1',
      fromMe: false,
    });

    await (handler as any)._processMessage({
      from: '5495555555555@s.whatsapp.net',
      businessId: 'business-1',
      message: 'quiero reservar',
      fromMe: false,
    });

    // getActiveReservationByPhone: policy block (#1), cancel menu (#2), final policy check (#3).
    // The confirmation turns ("2","1") resolve from the draft, not another DB lookup.
    expect(getActiveSpy).toHaveBeenCalledTimes(3);
    expect(cancelSpy).toHaveBeenCalledWith('entry-7', 'CANCELLED');
    expect(startReservationSpy).toHaveBeenCalledTimes(1);

    const sentMessages = mockBaileysService.sendMessage.mock.calls.map((call) => call[2]);
    expect(sentMessages.some((msg) => msg.includes('ya tenés una reserva para hoy'))).toBe(true);
    expect(sentMessages.some((msg) => msg.includes('¿Qué te gustaría hacer?'))).toBe(true);
    expect(sentMessages.some((msg) => msg.includes('¿Estás seguro de que querés cancelar'))).toBe(true);
    expect(sentMessages.some((msg) => msg.includes('fue cancelada correctamente'))).toBe(true);
    expect(sentMessages.some((msg) => msg.includes('¿Cuál es tu nombre para la reserva?'))).toBe(true);
  });

  it('blocks off-topic messages before calling the agent when there is no draft', async () => {
    jest
      .spyOn(ReservationService, 'getDraft')
      .mockResolvedValue(null);

    jest
      .spyOn(SupabaseService, 'getBusinessById')
      .mockResolvedValue({
        id: 'business-1',
        name: 'Restaurante Test',
        whatsapp_session_id: 'session-test-1',
      } as any);

    jest
      .spyOn(SupabaseService, 'getActiveReservationByPhone')
      .mockResolvedValue(null);

    const generateResponseSpy = jest
      .spyOn(agentService, 'generateResponse')
      .mockResolvedValue({
        response: 'unused',
        action: null,
        conversationId: 'business-1-5496666666666',
        agent: { id: 'waitlist', name: 'Asistente de Reservas' },
        processingTime: 5,
      } as any);

    await (handler as any)._processMessage({
      from: '5496666666666@s.whatsapp.net',
      businessId: 'business-1',
      message: '¿Cómo está el clima hoy?',
      fromMe: false,
    });

    expect(generateResponseSpy).not.toHaveBeenCalled();
    expect(mockBaileysService.sendMessage).toHaveBeenCalledWith(
      'business-1',
      '5496666666666@s.whatsapp.net',
      'Hola 😊 Solo puedo ayudarte con consultas relacionadas a reservas para “Restaurante Test” en el turno actual. ¿Querés hacer una reserva?'
    );
  });

  it('starts the reservation flow from a greeting with the original intro message', async () => {
    jest
      .spyOn(ReservationService, 'getDraft')
      .mockResolvedValue(null);

    jest
      .spyOn(agentService, 'clearConversationHistory')
      .mockResolvedValue(undefined);

    jest
      .spyOn(SupabaseService, 'getBusinessById')
      .mockResolvedValue({
        id: 'business-1',
        name: 'Restaurante Test',
        whatsapp_session_id: 'session-test-1',
      } as any);

    jest
      .spyOn(SupabaseService, 'getActiveReservationByPhone')
      .mockResolvedValue(null);

    jest
      .spyOn(agentService, 'generateResponse')
      .mockResolvedValue({
        response: '¡Hola! 👋 Soy el asistente de Restaurante Test y estoy para generar reservas. ¿Cuál es tu nombre?',
        action: 'CREATE_RESERVATION',
        conversationId: 'business-1-5491231231231',
        agent: { id: 'waitlist', name: 'Asistente de Reservas' },
        processingTime: 5,
      } as any);

    const startReservationSpy = jest
      .spyOn(ReservationService, 'startReservation')
      .mockResolvedValue({
        conversationId: 'business-1-5491231231231',
        businessId: 'business-1',
        step: 'name',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      } as any);

    await (handler as any)._processMessage({
      from: '5491231231231@s.whatsapp.net',
      businessId: 'business-1',
      message: 'Hola',
      fromMe: false,
    });

    expect(startReservationSpy).toHaveBeenCalledWith('business-1-5491231231231', 'business-1');
    expect(mockBaileysService.sendMessage).toHaveBeenCalledWith(
      'business-1',
      '5491231231231@s.whatsapp.net',
      expect.stringContaining('Soy el asistente de reservas de *Restaurante Test*')
    );
  });

  it('starts the reservation flow when the user answers yes to the reservation prompt', async () => {
    jest
      .spyOn(ReservationService, 'getDraft')
      .mockResolvedValue(null);

    jest
      .spyOn(SupabaseService, 'getBusinessById')
      .mockResolvedValue({
        id: 'business-1',
        name: 'Restaurante Test',
        whatsapp_session_id: 'session-test-1',
      } as any);

    jest
      .spyOn(SupabaseService, 'getActiveReservationByPhone')
      .mockResolvedValue(null);

    const generateResponseSpy = jest
      .spyOn(agentService, 'generateResponse')
      .mockResolvedValue({
        response: 'unused',
        action: null,
        conversationId: 'business-1-5493213213213',
        agent: { id: 'waitlist', name: 'Asistente de Reservas' },
        processingTime: 5,
      } as any);

    const startReservationSpy = jest
      .spyOn(ReservationService, 'startReservation')
      .mockResolvedValue({
        conversationId: 'business-1-5493213213213',
        businessId: 'business-1',
        step: 'name',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      } as any);

    await (handler as any)._processMessage({
      from: '5493213213213@s.whatsapp.net',
      businessId: 'business-1',
      message: 'Si',
      fromMe: false,
    });

    // Explicit opt-ins after a scope block skip the agent entirely — the bot already
    // introduced itself in the scope-guard message, so it goes straight to the name prompt.
    expect(generateResponseSpy).not.toHaveBeenCalled();
    expect(startReservationSpy).toHaveBeenCalledWith('business-1-5493213213213', 'business-1');
    expect(mockBaileysService.sendMessage).toHaveBeenCalledWith(
      'business-1',
      '5493213213213@s.whatsapp.net',
      '¿Cuál es tu nombre para la reserva?'
    );
  });

  it('handles a reservation request that already includes name and party size without using the agent', async () => {
    jest
      .spyOn(ReservationService, 'getDraft')
      .mockResolvedValue(null);

    jest
      .spyOn(SupabaseService, 'getBusinessById')
      .mockResolvedValue({
        id: 'business-1',
        name: 'Restaurante Test',
        whatsapp_session_id: 'session-test-1',
      } as any);

    jest
      .spyOn(SupabaseService, 'getActiveReservationByPhone')
      .mockResolvedValue(null);

    const startReservationSpy = jest
      .spyOn(ReservationService, 'startReservation')
      .mockResolvedValue({
        conversationId: 'business-1-5496546546546',
        businessId: 'business-1',
        step: 'name',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      } as any);

    const setCustomerNameSpy = jest
      .spyOn(ReservationService, 'setCustomerName')
      .mockResolvedValue({
        conversationId: 'business-1-5496546546546',
        businessId: 'business-1',
        step: 'party_size',
        customerName: 'Matías Andrada',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      } as any);

    const setPartySizeSpy = jest
      .spyOn(ReservationService, 'setPartySize')
      .mockResolvedValue({
        conversationId: 'business-1-5496546546546',
        businessId: 'business-1',
        step: 'party_size',
        customerName: 'Matías Andrada',
        partySize: 4,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      } as any);

    const moveToScheduleChoiceSpy = jest
      .spyOn(ReservationService, 'moveToScheduleChoice')
      .mockResolvedValue({
        conversationId: 'business-1-5496546546546',
        businessId: 'business-1',
        step: 'schedule_choice',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      } as any);

    const generateResponseSpy = jest
      .spyOn(agentService, 'generateResponse')
      .mockResolvedValue({
        response: 'unused',
        action: null,
        conversationId: 'business-1-5496546546546',
        agent: { id: 'waitlist', name: 'Asistente de Reservas' },
        processingTime: 5,
      } as any);

    await (handler as any)._processMessage({
      from: '5496546546546@s.whatsapp.net',
      businessId: 'business-1',
      message: 'Hola quiero reservar Matías Andrada 4 personas',
      fromMe: false,
    });

    expect(generateResponseSpy).not.toHaveBeenCalled();
    expect(startReservationSpy).toHaveBeenCalledWith('business-1-5496546546546', 'business-1');
    expect(setCustomerNameSpy).toHaveBeenCalledWith('business-1-5496546546546', 'Matías Andrada');
    expect(setPartySizeSpy).toHaveBeenCalledWith('business-1-5496546546546', 4);
    expect(moveToScheduleChoiceSpy).toHaveBeenCalledWith('business-1-5496546546546');
    expect(mockBaileysService.sendMessage).toHaveBeenCalledWith(
      'business-1',
      '5496546546546@s.whatsapp.net',
      expect.stringContaining('¿La reserva es para...?')
    );
  });

  it('blocks off-topic messages during the name step without saving them as customer name', async () => {
    jest
      .spyOn(ReservationService, 'getDraft')
      .mockResolvedValue({
        conversationId: 'business-1-5497777777777',
        businessId: 'business-1',
        step: 'name',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      } as any);

    jest
      .spyOn(SupabaseService, 'getBusinessById')
      .mockResolvedValue({
        id: 'business-1',
        name: 'Restaurante Test',
        whatsapp_session_id: 'session-test-1',
      } as any);

    const setCustomerNameSpy = jest
      .spyOn(ReservationService, 'setCustomerName')
      .mockResolvedValue({
        conversationId: 'business-1-5497777777777',
        businessId: 'business-1',
        step: 'party_size',
        customerName: 'Juan',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      } as any);

    await (handler as any)._processMessage({
      from: '5497777777777@s.whatsapp.net',
      businessId: 'business-1',
      message: 'Contame un chiste',
      fromMe: false,
    });

    expect(setCustomerNameSpy).not.toHaveBeenCalled();
    expect(mockBaileysService.sendMessage).toHaveBeenCalledWith(
      'business-1',
      '5497777777777@s.whatsapp.net',
      'Hola 😊 Solo puedo ayudarte con consultas relacionadas a reservas para “Restaurante Test” en el turno actual. ¿Querés hacer una reserva?'
    );
  });

  it('extracts party size from a message that also mentions a specific time, and moves to schedule_choice', async () => {
    jest
      .spyOn(ReservationService, 'getDraft')
      .mockResolvedValue({
        conversationId: 'business-1-5498888888888',
        businessId: 'business-1',
        step: 'party_size',
        customerName: 'Juan',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      } as any);

    jest
      .spyOn(SupabaseService, 'getBusinessById')
      .mockResolvedValue({
        id: 'business-1',
        name: 'Restaurante Test',
        whatsapp_session_id: 'session-test-1',
      } as any);

    const setPartySizeSpy = jest
      .spyOn(ReservationService, 'setPartySize')
      .mockResolvedValue({
        conversationId: 'business-1-5498888888888',
        businessId: 'business-1',
        step: 'party_size',
        customerName: 'Juan',
        partySize: 4,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      } as any);

    const moveToScheduleChoiceSpy = jest
      .spyOn(ReservationService, 'moveToScheduleChoice')
      .mockResolvedValue({
        conversationId: 'business-1-5498888888888',
        businessId: 'business-1',
        step: 'schedule_choice',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      } as any);

    await (handler as any)._processMessage({
      from: '5498888888888@s.whatsapp.net',
      businessId: 'business-1',
      message: 'A las 22:30 somos 4',
      fromMe: false,
    });

    // The time mention ("22:30") is stripped by extractPartySize and only handled
    // later, once the customer explicitly picks "otro día" at the schedule_choice step.
    expect(setPartySizeSpy).toHaveBeenCalledWith('business-1-5498888888888', 4);
    expect(moveToScheduleChoiceSpy).toHaveBeenCalledWith('business-1-5498888888888');
    expect(mockBaileysService.sendMessage).toHaveBeenCalledWith(
      'business-1',
      '5498888888888@s.whatsapp.net',
      expect.stringContaining('¿La reserva es para...?')
    );
  });

  it('asks again for the name instead of saving a reservation request as customer name', async () => {
    const setCustomerNameSpy = jest
      .spyOn(ReservationService, 'setCustomerName')
      .mockResolvedValue({
        conversationId: 'conv-9',
        businessId: 'business-1',
        step: 'party_size',
        customerName: 'Juan',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      } as any);

    const handled = await (handler as any).processDraftStep(
      {
        conversationId: 'conv-9',
        businessId: 'business-1',
        step: 'name',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      'Quiero reservar una mesa',
      'conv-9',
      'business-1',
      '5499999999999@s.whatsapp.net'
    );

    expect(handled).toBe(true);
    expect(setCustomerNameSpy).not.toHaveBeenCalled();
    expect(mockBaileysService.sendMessage).toHaveBeenCalledWith(
      'business-1',
      '5499999999999@s.whatsapp.net',
      '¿Cuál es tu nombre para continuar con la reserva?'
    );
  });

  it('accepts name and party size together during the name step', async () => {
    const setCustomerNameSpy = jest
      .spyOn(ReservationService, 'setCustomerName')
      .mockResolvedValue({
        conversationId: 'conv-10',
        businessId: 'business-1',
        step: 'party_size',
        customerName: 'Matías Andrada',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      } as any);

    const setPartySizeSpy = jest
      .spyOn(ReservationService, 'setPartySize')
      .mockResolvedValue({
        conversationId: 'conv-10',
        businessId: 'business-1',
        step: 'party_size',
        customerName: 'Matías Andrada',
        partySize: 4,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      } as any);

    const moveToScheduleChoiceSpy = jest
      .spyOn(ReservationService, 'moveToScheduleChoice')
      .mockResolvedValue({
        conversationId: 'conv-10',
        businessId: 'business-1',
        step: 'schedule_choice',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      } as any);

    const handled = await (handler as any).processDraftStep(
      {
        conversationId: 'conv-10',
        businessId: 'business-1',
        step: 'name',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      'Me llamo Matías Andrada somos 4 personas',
      'conv-10',
      'business-1',
      '5491010101010@s.whatsapp.net'
    );

    expect(handled).toBe(true);
    expect(setCustomerNameSpy).toHaveBeenCalledWith('conv-10', 'Matías Andrada');
    expect(setPartySizeSpy).toHaveBeenCalledWith('conv-10', 4);
    expect(moveToScheduleChoiceSpy).toHaveBeenCalledWith('conv-10');
    expect(mockBaileysService.sendMessage).toHaveBeenCalledWith(
      'business-1',
      '5491010101010@s.whatsapp.net',
      expect.stringContaining('¿La reserva es para...?')
    );
  });

  it('accepts name correction and party size together during the party_size step', async () => {
    const setNameOnlySpy = jest
      .spyOn(ReservationService, 'setNameOnly')
      .mockResolvedValue({
        conversationId: 'conv-11',
        businessId: 'business-1',
        step: 'party_size',
        customerName: 'Matías Andrada',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      } as any);

    const setPartySizeSpy = jest
      .spyOn(ReservationService, 'setPartySize')
      .mockResolvedValue({
        conversationId: 'conv-11',
        businessId: 'business-1',
        step: 'party_size',
        customerName: 'Matías Andrada',
        partySize: 4,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      } as any);

    const moveToScheduleChoiceSpy = jest
      .spyOn(ReservationService, 'moveToScheduleChoice')
      .mockResolvedValue({
        conversationId: 'conv-11',
        businessId: 'business-1',
        step: 'schedule_choice',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      } as any);

    const handled = await (handler as any).processDraftStep(
      {
        conversationId: 'conv-11',
        businessId: 'business-1',
        step: 'party_size',
        customerName: 'Si',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      'Me llamo Matías Andrada somos 4 personas',
      'conv-11',
      'business-1',
      '5491110101010@s.whatsapp.net'
    );

    expect(handled).toBe(true);
    expect(setNameOnlySpy).toHaveBeenCalledWith('conv-11', 'Matías Andrada');
    expect(setPartySizeSpy).toHaveBeenCalledWith('conv-11', 4);
    expect(moveToScheduleChoiceSpy).toHaveBeenCalledWith('conv-11');
    expect(mockBaileysService.sendMessage).toHaveBeenCalledWith(
      'business-1',
      '5491110101010@s.whatsapp.net',
      expect.stringContaining('¿La reserva es para...?')
    );
  });

  describe('party_size step — name correction follow-up (awaitingNameCorrection)', () => {
    const draftAtPartySize = (overrides: Partial<Record<string, unknown>> = {}) => ({
      conversationId: 'conv-name-fix',
      businessId: 'business-1',
      step: 'party_size' as const,
      customerName: 'Martita',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...overrides,
    });

    it('marks the draft as awaiting a name correction when the correction phrase has no extractable name', async () => {
      const saveDraftSpy = jest.spyOn(ReservationService, 'saveDraft').mockResolvedValue(undefined as any);

      const handled = await (handler as any).processDraftStep(
        draftAtPartySize(),
        'Perdón quiero cambiar el nombre a Marta juarez',
        'conv-name-fix',
        'business-1',
        '5491234567890@s.whatsapp.net'
      );

      expect(handled).toBe(true);
      expect(saveDraftSpy).toHaveBeenCalledWith(
        expect.objectContaining({ awaitingNameCorrection: true })
      );
      expect(mockBaileysService.sendMessage).toHaveBeenCalledWith(
        'business-1',
        '5491234567890@s.whatsapp.net',
        '¿Cuál es tu nombre correcto para continuar con la reserva?'
      );
    });

    it('applies a bare-name follow-up reply instead of bouncing it, once awaitingNameCorrection is set', async () => {
      // Regression: previously this exact reply ("Marta Juarez", no "me llamo"
      // phrase) never reached this handler — the scope guard rejected it as
      // off-topic first, trapping the customer in an infinite loop.
      const setNameOnlySpy = jest
        .spyOn(ReservationService, 'setNameOnly')
        .mockResolvedValue(draftAtPartySize({ customerName: 'Marta Juarez' }) as any);
      const saveDraftSpy = jest.spyOn(ReservationService, 'saveDraft').mockResolvedValue(undefined as any);

      const handled = await (handler as any).processDraftStep(
        draftAtPartySize({ awaitingNameCorrection: true }),
        'Marta Juarez',
        'conv-name-fix',
        'business-1',
        '5491234567890@s.whatsapp.net'
      );

      expect(handled).toBe(true);
      expect(saveDraftSpy).toHaveBeenCalledWith(
        expect.objectContaining({ awaitingNameCorrection: false })
      );
      expect(setNameOnlySpy).toHaveBeenCalledWith('conv-name-fix', 'Marta Juarez');
      expect(mockBaileysService.sendMessage).toHaveBeenCalledWith(
        'business-1',
        '5491234567890@s.whatsapp.net',
        expect.stringContaining('Cambié tu nombre a *Marta Juarez*')
      );
      // Must NOT be the off-topic bounce that caused the original loop.
      expect(mockBaileysService.sendMessage).not.toHaveBeenCalledWith(
        'business-1',
        '5491234567890@s.whatsapp.net',
        expect.stringContaining('Solo puedo ayudarte')
      );
    });

    it('re-asks (without looping forever) when the follow-up reply still is not a usable name', async () => {
      const saveDraftSpy = jest.spyOn(ReservationService, 'saveDraft').mockResolvedValue(undefined as any);
      const deleteDraftSpy = jest.spyOn(ReservationService, 'deleteDraft').mockResolvedValue(undefined as any);

      const handled = await (handler as any).processDraftStep(
        draftAtPartySize({ awaitingNameCorrection: true, invalidAttempts: 0 }),
        '???',
        'conv-name-fix',
        'business-1',
        '5491234567890@s.whatsapp.net'
      );

      expect(handled).toBe(true);
      expect(deleteDraftSpy).not.toHaveBeenCalled();
      expect(saveDraftSpy).toHaveBeenCalledWith(expect.objectContaining({ invalidAttempts: 1 }));
      expect(mockBaileysService.sendMessage).toHaveBeenCalledWith(
        'business-1',
        '5491234567890@s.whatsapp.net',
        expect.stringContaining('No reconocí eso como un nombre')
      );
    });

    it('cancels the draft after 2 failed follow-up attempts instead of looping forever', async () => {
      const deleteDraftSpy = jest.spyOn(ReservationService, 'deleteDraft').mockResolvedValue(undefined as any);

      const handled = await (handler as any).processDraftStep(
        draftAtPartySize({ awaitingNameCorrection: true, invalidAttempts: 1 }),
        '???',
        'conv-name-fix',
        'business-1',
        '5491234567890@s.whatsapp.net'
      );

      expect(handled).toBe(true);
      expect(deleteDraftSpy).toHaveBeenCalledWith('conv-name-fix');
      expect(mockBaileysService.sendMessage).toHaveBeenCalledWith(
        'business-1',
        '5491234567890@s.whatsapp.net',
        expect.stringContaining('Demasiados intentos inválidos')
      );
    });
  });

  describe('schedule_choice / date / time steps', () => {
    // Thursday 2026-07-02, 12:00 BA wall-clock time.
    const NOW_BA = new Date('2026-07-02T12:00:00.000Z');
    let dateNowSpy: jest.SpyInstance<number, []>;

    beforeEach(() => {
      jest.spyOn(ReservationDatetime, 'nowInBuenosAires').mockReturnValue(NOW_BA);
      // isInPast() reads the real Date.now() directly, so it must be frozen too —
      // otherwise these hardcoded 2026-07-xx fixtures silently become "in the past"
      // once the real clock catches up to them.
      dateNowSpy = jest
        .spyOn(Date, 'now')
        .mockReturnValue(NOW_BA.getTime() + ReservationDatetime.BA_OFFSET_MS);
    });

    afterEach(() => {
      dateNowSpy.mockRestore();
    });

    const scheduleChoiceDraft = (overrides: Partial<Record<string, unknown>> = {}) => ({
      conversationId: 'conv-sched',
      businessId: 'business-1',
      step: 'schedule_choice' as const,
      customerName: 'Ana',
      partySize: 2,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...overrides,
    });

    it('asks for the specific hour (instead of jumping to the summary) when choosing "1" and the business is open', async () => {
      jest.spyOn(SupabaseService, 'getBusinessById').mockResolvedValue({
        id: 'business-1',
        name: 'Restaurante Test',
        weekly_hours: { thu: { closed: false, shifts: [{ open: '08:00', close: '23:00' }] } },
      } as any);

      const setInstantScheduleSpy = jest.spyOn(ReservationService, 'setInstantSchedule');
      const showSummarySpy = jest
        .spyOn(handler as any, 'showReservationSummary')
        .mockResolvedValue(undefined);
      const saveDraftSpy = jest.spyOn(ReservationService, 'saveDraft').mockResolvedValue(undefined as any);

      const handled = await (handler as any).processDraftStep(
        scheduleChoiceDraft(),
        '1',
        'conv-sched',
        'business-1',
        '5491234567890@s.whatsapp.net'
      );

      expect(handled).toBe(true);
      expect(setInstantScheduleSpy).not.toHaveBeenCalled();
      expect(showSummarySpy).not.toHaveBeenCalled();
      expect(saveDraftSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          pendingTodayTimeChoice: { dateKey: '2026-07-02', closeLabel: '22:45' },
        })
      );
      expect(mockBaileysService.sendMessage).toHaveBeenCalledWith(
        'business-1',
        '5491234567890@s.whatsapp.net',
        expect.stringContaining('22:45')
      );
    });

    it('books the specific hour when answered after being asked for today\'s time', async () => {
      jest.spyOn(SupabaseService, 'getBusinessById').mockResolvedValue({
        id: 'business-1',
        name: 'Restaurante Test',
        weekly_hours: { thu: { closed: false, shifts: [{ open: '08:00', close: '23:00' }] } },
      } as any);

      const setScheduledTimeSpy = jest
        .spyOn(ReservationService, 'setScheduledTime')
        .mockResolvedValue(scheduleChoiceDraft() as any);
      const showSummarySpy = jest
        .spyOn(handler as any, 'showReservationSummary')
        .mockResolvedValue(undefined);

      const draftWithPending = scheduleChoiceDraft({
        pendingTodayTimeChoice: { dateKey: '2026-07-02', closeLabel: '22:45' },
      });

      const handled = await (handler as any).processDraftStep(
        draftWithPending,
        '21:00',
        'conv-sched',
        'business-1',
        '5491234567890@s.whatsapp.net'
      );

      expect(handled).toBe(true);
      expect(setScheduledTimeSpy).toHaveBeenCalledWith('conv-sched', '21:00', expect.any(String));
      expect(showSummarySpy).toHaveBeenCalledWith(
        'conv-sched',
        'business-1',
        '5491234567890@s.whatsapp.net'
      );
    });

    it('re-asks for today\'s time (without losing the pending flag) when the first hour given has already passed — regression', async () => {
      jest.spyOn(SupabaseService, 'getBusinessById').mockResolvedValue({
        id: 'business-1',
        name: 'Restaurante Test',
        weekly_hours: { thu: { closed: false, shifts: [{ open: '08:00', close: '23:00' }] } },
      } as any);

      const moveToConfirmSlotSpy = jest
        .spyOn(ReservationService, 'moveToConfirmSlot')
        .mockResolvedValue(scheduleChoiceDraft() as any);

      const draftWithPending = scheduleChoiceDraft({
        pendingTodayTimeChoice: { dateKey: '2026-07-02', closeLabel: '22:45' },
      });

      // Current BA time is 12:00 — "11" (11:00) has already passed today.
      const firstHandled = await (handler as any).processDraftStep(
        draftWithPending,
        '11',
        'conv-sched',
        'business-1',
        '5491234567890@s.whatsapp.net'
      );

      expect(firstHandled).toBe(true);
      // When a past time is given for today, offer the same time tomorrow
      expect(mockBaileysService.sendMessage).toHaveBeenCalledWith(
        'business-1',
        '5491234567890@s.whatsapp.net',
        expect.stringContaining('mañana a las *11:00*')
      );
      // Verify that the system moves to confirm_slot to ask for confirmation
      expect(moveToConfirmSlotSpy).toHaveBeenCalledWith(
        'conv-sched',
        '2026-07-03', // Next day (Friday)
        '11:00',
        expect.any(String),
        'time'
      );
    });

    it('keeps the instant/current-turn behavior when answering "ahora" after being asked for today\'s time', async () => {
      const setInstantScheduleSpy = jest
        .spyOn(ReservationService, 'setInstantSchedule')
        .mockResolvedValue(scheduleChoiceDraft() as any);
      const showSummarySpy = jest
        .spyOn(handler as any, 'showReservationSummary')
        .mockResolvedValue(undefined);

      const draftWithPending = scheduleChoiceDraft({
        pendingTodayTimeChoice: { dateKey: '2026-07-02', closeLabel: '22:45' },
      });

      const handled = await (handler as any).processDraftStep(
        draftWithPending,
        'ahora',
        'conv-sched',
        'business-1',
        '5491234567890@s.whatsapp.net'
      );

      expect(handled).toBe(true);
      expect(setInstantScheduleSpy).toHaveBeenCalledWith('conv-sched');
      expect(showSummarySpy).toHaveBeenCalledWith(
        'conv-sched',
        'business-1',
        '5491234567890@s.whatsapp.net'
      );
    });

    it('proposes the next open slot when choosing "1" but the business is currently closed', async () => {
      jest.spyOn(SupabaseService, 'getBusinessById').mockResolvedValue({
        id: 'business-1',
        name: 'Restaurante Test',
        weekly_hours: { thu: { closed: false, shifts: [{ open: '17:00', close: '23:00' }] } },
      } as any);

      const moveToConfirmSlotSpy = jest
        .spyOn(ReservationService, 'moveToConfirmSlot')
        .mockResolvedValue(scheduleChoiceDraft({ step: 'confirm_slot' }) as any);

      const handled = await (handler as any).processDraftStep(
        scheduleChoiceDraft(),
        '1',
        'conv-sched',
        'business-1',
        '5491234567890@s.whatsapp.net'
      );

      expect(handled).toBe(true);
      expect(moveToConfirmSlotSpy).toHaveBeenCalledWith(
        'conv-sched',
        '2026-07-02',
        '17:15',
        expect.any(String),
        'schedule_choice'
      );
      expect(mockBaileysService.sendMessage).toHaveBeenCalledWith(
        'business-1',
        '5491234567890@s.whatsapp.net',
        expect.stringContaining('hoy 02/07 a las 17:15')
      );
    });

    it('moves to the date step when choosing "2"', async () => {
      const moveToDateStepSpy = jest
        .spyOn(ReservationService, 'moveToDateStep')
        .mockResolvedValue(scheduleChoiceDraft({ step: 'date' }) as any);

      const handled = await (handler as any).processDraftStep(
        scheduleChoiceDraft(),
        '2',
        'conv-sched',
        'business-1',
        '5491234567890@s.whatsapp.net'
      );

      expect(handled).toBe(true);
      expect(moveToDateStepSpy).toHaveBeenCalledWith('conv-sched');
      expect(mockBaileysService.sendMessage).toHaveBeenCalledWith(
        'business-1',
        '5491234567890@s.whatsapp.net',
        expect.stringContaining('¿Para qué día de la semana lo quiere?')
      );
    });

    it('accepts a day named directly in the schedule_choice answer (within the 7-day window)', async () => {
      const setScheduledDateSpy = jest
        .spyOn(ReservationService, 'setScheduledDate')
        .mockResolvedValue(scheduleChoiceDraft({ step: 'time' }) as any);

      const handled = await (handler as any).processDraftStep(
        scheduleChoiceDraft(),
        'el viernes',
        'conv-sched',
        'business-1',
        '5491234567890@s.whatsapp.net'
      );

      expect(handled).toBe(true);
      expect(setScheduledDateSpy).toHaveBeenCalledWith(
        'conv-sched',
        expect.objectContaining({ label: 'viernes 03/07' })
      );
      expect(mockBaileysService.sendMessage).toHaveBeenCalledWith(
        'business-1',
        '5491234567890@s.whatsapp.net',
        '🕐 ¿A qué hora te gustaría reservar para el viernes 03/07?'
      );
    });

    it('rejects a day the business is closed at the date step', async () => {
      jest.spyOn(SupabaseService, 'getBusinessById').mockResolvedValue({
        id: 'business-1',
        name: 'Restaurante Test',
        weekly_hours: { fri: { closed: true, shifts: [] } },
      } as any);

      const saveDraftSpy = jest.spyOn(ReservationService, 'saveDraft').mockResolvedValue(undefined as any);

      const handled = await (handler as any).processDraftStep(
        scheduleChoiceDraft({ step: 'date' }),
        'el viernes',
        'conv-sched',
        'business-1',
        '5491234567890@s.whatsapp.net'
      );

      expect(handled).toBe(true);
      expect(saveDraftSpy).toHaveBeenCalled();
      expect(mockBaileysService.sendMessage).toHaveBeenCalledWith(
        'business-1',
        '5491234567890@s.whatsapp.net',
        expect.stringContaining('cerrado los viernes')
      );
    });

    it('finishes the reservation when a valid time inside business hours is given', async () => {
      jest.spyOn(SupabaseService, 'getBusinessById').mockResolvedValue({
        id: 'business-1',
        name: 'Restaurante Test',
        weekly_hours: { fri: { closed: false, shifts: [{ open: '08:00', close: '23:00' }] } },
      } as any);

      const setScheduledTimeSpy = jest
        .spyOn(ReservationService, 'setScheduledTime')
        .mockResolvedValue(scheduleChoiceDraft({ step: 'completed' }) as any);
      const showSummarySpy = jest
        .spyOn(handler as any, 'showReservationSummary')
        .mockResolvedValue(undefined);

      const handled = await (handler as any).processDraftStep(
        scheduleChoiceDraft({ step: 'time', scheduledDate: '2026-07-03' }),
        '21:00',
        'conv-sched',
        'business-1',
        '5491234567890@s.whatsapp.net'
      );

      expect(handled).toBe(true);
      expect(setScheduledTimeSpy).toHaveBeenCalledWith('conv-sched', '21:00', '2026-07-04T00:00:00.000Z');
      expect(showSummarySpy).toHaveBeenCalledWith(
        'conv-sched',
        'business-1',
        '5491234567890@s.whatsapp.net'
      );
    });

    it('finishes the reservation for TODAY when the customer types "HH:MMhs" pegado (regresión: "ya pasó ... mañana a las *00:00*")', async () => {
      jest.spyOn(SupabaseService, 'getBusinessById').mockResolvedValue({
        id: 'business-1',
        name: 'Restaurante Test',
        weekly_hours: { thu: { closed: false, shifts: [{ open: '08:00', close: '23:00' }] } },
      } as any);

      const setScheduledTimeSpy = jest
        .spyOn(ReservationService, 'setScheduledTime')
        .mockResolvedValue(scheduleChoiceDraft({ step: 'completed' }) as any);
      const showSummarySpy = jest
        .spyOn(handler as any, 'showReservationSummary')
        .mockResolvedValue(undefined);

      // "Ahora" BA es 12:00 (congelado en el beforeEach del describe). "13:00hs"
      // (pegado, sin espacio antes de "hs") es 1 hora en el futuro, hoy mismo.
      // Antes del fix de parseTimeOfDay esto se malparseaba como
      // {hour: 0, minute: 0} (los MINUTOS de "13:00" leídos como hora), lo que
      // isInPast marcaba como pasado, generando "Ese horario ya pasó para
      // hoy... mañana a las *00:00*".
      const handled = await (handler as any).processDraftStep(
        scheduleChoiceDraft({ step: 'time', scheduledDate: '2026-07-02' }),
        '13:00hs',
        'conv-sched',
        'business-1',
        '5491234567890@s.whatsapp.net'
      );

      expect(handled).toBe(true);
      expect(setScheduledTimeSpy).toHaveBeenCalledWith('conv-sched', '13:00', '2026-07-02T16:00:00.000Z');
      expect(showSummarySpy).toHaveBeenCalledWith(
        'conv-sched',
        'business-1',
        '5491234567890@s.whatsapp.net'
      );
      expect(mockBaileysService.sendMessage).not.toHaveBeenCalledWith(
        'business-1',
        '5491234567890@s.whatsapp.net',
        expect.stringContaining('ya pasó')
      );
    });

    it('proposes the next same-day slot when the requested time falls in a closed gap', async () => {
      jest.spyOn(SupabaseService, 'getBusinessById').mockResolvedValue({
        id: 'business-1',
        name: 'Restaurante Test',
        weekly_hours: {
          fri: {
            closed: false,
            shifts: [
              { open: '08:00', close: '14:00' },
              { open: '17:00', close: '23:00' },
            ],
          },
        },
      } as any);

      const moveToConfirmSlotSpy = jest
        .spyOn(ReservationService, 'moveToConfirmSlot')
        .mockResolvedValue(scheduleChoiceDraft({ step: 'confirm_slot' }) as any);

      const handled = await (handler as any).processDraftStep(
        scheduleChoiceDraft({ step: 'time', scheduledDate: '2026-07-03' }),
        '15:00',
        'conv-sched',
        'business-1',
        '5491234567890@s.whatsapp.net'
      );

      expect(handled).toBe(true);
      expect(moveToConfirmSlotSpy).toHaveBeenCalledWith(
        'conv-sched',
        '2026-07-03',
        '17:15',
        expect.any(String),
        'time'
      );
      expect(mockBaileysService.sendMessage).toHaveBeenCalledWith(
        'business-1',
        '5491234567890@s.whatsapp.net',
        expect.stringContaining('a las *17:15*')
      );
    });

    it('overrides both the day and the party size when they are mentioned alongside the time at the "time" step', async () => {
      jest.spyOn(SupabaseService, 'getBusinessById').mockResolvedValue(null as any);

      const setScheduledDateSpy = jest
        .spyOn(ReservationService, 'setScheduledDate')
        .mockResolvedValue(scheduleChoiceDraft({ step: 'time' }) as any);
      const setPartySizeSpy = jest
        .spyOn(ReservationService, 'setPartySize')
        .mockResolvedValue(scheduleChoiceDraft({ step: 'time' }) as any);
      const setScheduledTimeSpy = jest
        .spyOn(ReservationService, 'setScheduledTime')
        .mockResolvedValue(scheduleChoiceDraft({ step: 'completed' }) as any);
      const showSummarySpy = jest
        .spyOn(handler as any, 'showReservationSummary')
        .mockResolvedValue(undefined);

      // Draft was left on Wednesday (2026-07-08) from a previous step, but the
      // customer now asks for Tuesday, 14hs, for 2 people — all in one message.
      const handled = await (handler as any).processDraftStep(
        scheduleChoiceDraft({ step: 'time', scheduledDate: '2026-07-08', partySize: 4 }),
        'Puede ser una reserva para el martes a las 14 para 2 personas?',
        'conv-sched',
        'business-1',
        '5491234567890@s.whatsapp.net'
      );

      expect(handled).toBe(true);
      expect(setScheduledDateSpy).toHaveBeenCalledWith(
        'conv-sched',
        expect.objectContaining({ label: 'martes 07/07' })
      );
      expect(setPartySizeSpy).toHaveBeenCalledWith('conv-sched', 2);
      expect(setScheduledTimeSpy).toHaveBeenCalledWith(
        'conv-sched',
        '14:00',
        '2026-07-07T17:00:00.000Z'
      );
      expect(showSummarySpy).toHaveBeenCalledWith(
        'conv-sched',
        'business-1',
        '5491234567890@s.whatsapp.net'
      );
    });

    it('does not misinterpret a bare hour reply at the "time" step as a party-size change', async () => {
      jest.spyOn(SupabaseService, 'getBusinessById').mockResolvedValue(null as any);

      const setPartySizeSpy = jest.spyOn(ReservationService, 'setPartySize');
      const setScheduledTimeSpy = jest
        .spyOn(ReservationService, 'setScheduledTime')
        .mockResolvedValue(scheduleChoiceDraft({ step: 'completed' }) as any);
      jest.spyOn(handler as any, 'showReservationSummary').mockResolvedValue(undefined);

      await (handler as any).processDraftStep(
        scheduleChoiceDraft({ step: 'time', scheduledDate: '2026-07-08', partySize: 4 }),
        '14',
        'conv-sched',
        'business-1',
        '5491234567890@s.whatsapp.net'
      );

      expect(setPartySizeSpy).not.toHaveBeenCalled();
      expect(setScheduledTimeSpy).toHaveBeenCalledWith('conv-sched', '14:00', expect.any(String));
    });

    it('re-asks for the time (without the generic off-topic message) when the customer echoes the date instead — regression', async () => {
      // Regression for a real conversation: the bot asked "¿A qué hora te gustaría
      // reservar para el jueves 09/07?" and the customer replied "09/07" (echoing
      // the date instead of giving an hour). That reply used to get scope-blocked
      // as off-topic, which never advanced draft.step past 'time'.
      const saveDraftSpy = jest.spyOn(ReservationService, 'saveDraft').mockResolvedValue(undefined as any);

      const handled = await (handler as any).processDraftStep(
        scheduleChoiceDraft({ step: 'time', scheduledDate: '2026-07-09', partySize: 4 }),
        '09/07',
        'conv-sched',
        'business-1',
        '5491234567890@s.whatsapp.net'
      );

      expect(handled).toBe(true);
      expect(saveDraftSpy).toHaveBeenCalledWith(expect.objectContaining({ invalidAttempts: 1 }));
      expect(mockBaileysService.sendMessage).toHaveBeenCalledWith(
        'business-1',
        '5491234567890@s.whatsapp.net',
        expect.stringContaining('horario')
      );
    });

    it.each(['Hola', 'Si'])(
      'recovers from a "%s" reply at the "time" step instead of repeating the off-topic message forever — regression',
      async (reply) => {
        // Once the customer's reply got scope-blocked (see test above), the draft
        // stayed on 'time' forever, so every later message — including a plain
        // "Hola" or "Si" — kept hitting the same restrictive branch and got the
        // exact same "Solo puedo ayudarte..." reply on every single turn.
        const saveDraftSpy = jest.spyOn(ReservationService, 'saveDraft').mockResolvedValue(undefined as any);

        const handled = await (handler as any).processDraftStep(
          scheduleChoiceDraft({ step: 'time', scheduledDate: '2026-07-09', partySize: 4 }),
          reply,
          'conv-sched',
          'business-1',
          '5491234567890@s.whatsapp.net'
        );

        expect(handled).toBe(true);
        expect(mockBaileysService.sendMessage).toHaveBeenCalledWith(
          'business-1',
          '5491234567890@s.whatsapp.net',
          expect.stringContaining('horario')
        );
        expect(mockBaileysService.sendMessage).not.toHaveBeenCalledWith(
          'business-1',
          '5491234567890@s.whatsapp.net',
          expect.stringContaining('Solo puedo ayudarte')
        );

        // A friendly interjection should never burn an invalid attempt / risk
        // cancelling the draft after just two "Hola"s.
        expect(saveDraftSpy).not.toHaveBeenCalled();
      }
    );

    it('finishes directly when the "date" step answer also includes a time, skipping the redundant "¿A qué hora?" ask', async () => {
      jest.spyOn(SupabaseService, 'getBusinessById').mockResolvedValue({
        id: 'business-1',
        name: 'Restaurante Test',
        weekly_hours: {
          wed: {
            closed: false,
            shifts: [
              { open: '08:00', close: '14:00' },
              { open: '17:00', close: '23:00' },
            ],
          },
        },
      } as any);

      const setScheduledDateSpy = jest
        .spyOn(ReservationService, 'setScheduledDate')
        .mockResolvedValue(scheduleChoiceDraft({ step: 'time' }) as any);
      const setScheduledTimeSpy = jest
        .spyOn(ReservationService, 'setScheduledTime')
        .mockResolvedValue(scheduleChoiceDraft({ step: 'completed' }) as any);
      const showSummarySpy = jest
        .spyOn(handler as any, 'showReservationSummary')
        .mockResolvedValue(undefined);

      const handled = await (handler as any).processDraftStep(
        scheduleChoiceDraft({ step: 'date' }),
        'El miércoles a las 19',
        'conv-sched',
        'business-1',
        '5491234567890@s.whatsapp.net'
      );

      expect(handled).toBe(true);
      expect(setScheduledDateSpy).toHaveBeenCalledWith(
        'conv-sched',
        expect.objectContaining({ label: 'miércoles 08/07' })
      );
      expect(setScheduledTimeSpy).toHaveBeenCalledWith('conv-sched', '19:00', expect.any(String));
      expect(showSummarySpy).toHaveBeenCalledWith(
        'conv-sched',
        'business-1',
        '5491234567890@s.whatsapp.net'
      );
      expect(mockBaileysService.sendMessage).not.toHaveBeenCalledWith(
        'business-1',
        '5491234567890@s.whatsapp.net',
        expect.stringContaining('¿A qué hora')
      );
    });

    it('finishes directly when the schedule_choice inline day answer also includes a time', async () => {
      jest.spyOn(SupabaseService, 'getBusinessById').mockResolvedValue({
        id: 'business-1',
        name: 'Restaurante Test',
        weekly_hours: { fri: { closed: false, shifts: [{ open: '08:00', close: '23:00' }] } },
      } as any);

      const setScheduledDateSpy = jest
        .spyOn(ReservationService, 'setScheduledDate')
        .mockResolvedValue(scheduleChoiceDraft({ step: 'time' }) as any);
      const setScheduledTimeSpy = jest
        .spyOn(ReservationService, 'setScheduledTime')
        .mockResolvedValue(scheduleChoiceDraft({ step: 'completed' }) as any);
      const showSummarySpy = jest
        .spyOn(handler as any, 'showReservationSummary')
        .mockResolvedValue(undefined);

      const handled = await (handler as any).processDraftStep(
        scheduleChoiceDraft(),
        'el viernes a las 21',
        'conv-sched',
        'business-1',
        '5491234567890@s.whatsapp.net'
      );

      expect(handled).toBe(true);
      expect(setScheduledDateSpy).toHaveBeenCalledWith(
        'conv-sched',
        expect.objectContaining({ label: 'viernes 03/07' })
      );
      expect(setScheduledTimeSpy).toHaveBeenCalledWith('conv-sched', '21:00', expect.any(String));
      expect(showSummarySpy).toHaveBeenCalledWith(
        'conv-sched',
        'business-1',
        '5491234567890@s.whatsapp.net'
      );
      expect(mockBaileysService.sendMessage).not.toHaveBeenCalledWith(
        'business-1',
        '5491234567890@s.whatsapp.net',
        expect.stringContaining('¿A qué hora')
      );
    });
  });

  describe('confirm_slot step', () => {
    // Thursday 2026-07-02, 12:00 BA wall-clock time.
    const NOW_BA = new Date('2026-07-02T12:00:00.000Z');
    let dateNowSpy: jest.SpyInstance<number, []>;

    beforeEach(() => {
      jest.spyOn(ReservationDatetime, 'nowInBuenosAires').mockReturnValue(NOW_BA);
      jest.spyOn(SupabaseService, 'getBusinessById').mockResolvedValue(null as any);
      dateNowSpy = jest
        .spyOn(Date, 'now')
        .mockReturnValue(NOW_BA.getTime() + ReservationDatetime.BA_OFFSET_MS);
    });

    afterEach(() => {
      dateNowSpy.mockRestore();
    });

    const confirmSlotDraft = (overrides: Partial<Record<string, unknown>> = {}) => ({
      conversationId: 'conv-sched',
      businessId: 'business-1',
      step: 'confirm_slot' as const,
      customerName: 'Matías',
      partySize: 4,
      scheduledDate: '2026-07-02',
      scheduledTime: '17:15',
      scheduledAt: '2026-07-02T20:15:00.000Z',
      confirmSlotOrigin: 'schedule_choice' as const,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...overrides,
    });

    it('re-proposes a different day when the customer asks to change it, keeping the originally offered time', async () => {
      const moveToConfirmSlotSpy = jest
        .spyOn(ReservationService, 'moveToConfirmSlot')
        .mockResolvedValue(confirmSlotDraft() as any);

      const handled = await (handler as any).processDraftStep(
        confirmSlotDraft(),
        'Puede ser el martes?',
        'conv-sched',
        'business-1',
        '5491234567890@s.whatsapp.net'
      );

      expect(handled).toBe(true);
      expect(moveToConfirmSlotSpy).toHaveBeenCalledWith(
        'conv-sched',
        '2026-07-07',
        '17:15',
        '2026-07-07T20:15:00.000Z',
        'schedule_choice'
      );
      expect(mockBaileysService.sendMessage).toHaveBeenCalledWith(
        'business-1',
        '5491234567890@s.whatsapp.net',
        expect.stringContaining('martes 07/07 a las 17:15')
      );
      expect(mockBaileysService.sendMessage).toHaveBeenCalledWith(
        'business-1',
        '5491234567890@s.whatsapp.net',
        expect.stringMatching(/\*sí\*.*\*no\*/)
      );
    });

    it('re-proposes both day and time when the customer specifies them together', async () => {
      const moveToConfirmSlotSpy = jest
        .spyOn(ReservationService, 'moveToConfirmSlot')
        .mockResolvedValue(confirmSlotDraft() as any);

      const handled = await (handler as any).processDraftStep(
        confirmSlotDraft(),
        'Si el martes a las 10',
        'conv-sched',
        'business-1',
        '5491234567890@s.whatsapp.net'
      );

      expect(handled).toBe(true);
      expect(moveToConfirmSlotSpy).toHaveBeenCalledWith(
        'conv-sched',
        '2026-07-07',
        '10:00',
        '2026-07-07T13:00:00.000Z',
        'schedule_choice'
      );
      expect(mockBaileysService.sendMessage).toHaveBeenCalledWith(
        'business-1',
        '5491234567890@s.whatsapp.net',
        expect.stringContaining('martes 07/07 a las 10:00')
      );
    });

    it('creates the reservation using the re-proposed slot once the customer finally confirms', async () => {
      const createAndNotifySpy = jest
        .spyOn(handler as any, 'createAndNotifyReservation')
        .mockResolvedValue(undefined);

      const handled = await (handler as any).processDraftStep(
        confirmSlotDraft({
          scheduledDate: '2026-07-07',
          scheduledTime: '10:00',
          scheduledAt: '2026-07-07T13:00:00.000Z',
        }),
        'si',
        'conv-sched',
        'business-1',
        '5491234567890@s.whatsapp.net'
      );

      expect(handled).toBe(true);
      expect(createAndNotifySpy).toHaveBeenCalledWith(
        'conv-sched',
        'business-1',
        '5491234567890@s.whatsapp.net'
      );
    });

    it('re-sends the confirmation prompt with the explicit slot label on an unrecognized reply', async () => {
      const handled = await (handler as any).processDraftStep(
        confirmSlotDraft(),
        'tal vez',
        'conv-sched',
        'business-1',
        '5491234567890@s.whatsapp.net'
      );

      expect(handled).toBe(true);
      expect(mockBaileysService.sendMessage).toHaveBeenCalledWith(
        'business-1',
        '5491234567890@s.whatsapp.net',
        expect.stringContaining('hoy 02/07 a las 17:15')
      );
    });
  });

  describe('handleGreeting — preserves in-progress drafts', () => {
    it('does not cancel a draft that is in confirm_slot (a slot is pending sí/no)', async () => {
      jest.spyOn(ReservationService, 'getDraft').mockResolvedValue({
        conversationId: 'conv-greet',
        businessId: 'business-1',
        step: 'confirm_slot',
        confirmSlotOrigin: 'schedule_choice',
        scheduledDate: '2026-07-08',
        scheduledTime: '10:00',
        scheduledAt: '2026-07-08T13:00:00.000Z',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      } as any);
      const deleteDraftSpy = jest.spyOn(ReservationService, 'deleteDraft').mockResolvedValue(undefined as any);
      const getActiveReservationSpy = jest.spyOn(SupabaseService, 'getActiveReservationByPhone');

      const handled = await (handler as any).handleGreeting(
        'Hola',
        'business-1',
        '5491234567890@s.whatsapp.net',
        'conv-greet'
      );

      expect(handled).toBe(false);
      expect(deleteDraftSpy).not.toHaveBeenCalled();
      expect(getActiveReservationSpy).not.toHaveBeenCalled();
    });

    it('does not cancel a draft that is in edit_menu', async () => {
      jest.spyOn(ReservationService, 'getDraft').mockResolvedValue({
        conversationId: 'conv-greet',
        businessId: 'business-1',
        step: 'edit_menu',
        existingReservationId: 'res-1',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      } as any);
      const deleteDraftSpy = jest.spyOn(ReservationService, 'deleteDraft').mockResolvedValue(undefined as any);

      const handled = await (handler as any).handleGreeting(
        'Hola',
        'business-1',
        '5491234567890@s.whatsapp.net',
        'conv-greet'
      );

      expect(handled).toBe(false);
      expect(deleteDraftSpy).not.toHaveBeenCalled();
    });

    it('does not cancel a draft in editMode regardless of which step it is on', async () => {
      jest.spyOn(ReservationService, 'getDraft').mockResolvedValue({
        conversationId: 'conv-greet',
        businessId: 'business-1',
        step: 'time',
        editMode: true,
        existingReservationId: 'res-1',
        scheduledDate: '2026-07-08',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      } as any);
      const deleteDraftSpy = jest.spyOn(ReservationService, 'deleteDraft').mockResolvedValue(undefined as any);

      const handled = await (handler as any).handleGreeting(
        'Hola',
        'business-1',
        '5491234567890@s.whatsapp.net',
        'conv-greet'
      );

      expect(handled).toBe(false);
      expect(deleteDraftSpy).not.toHaveBeenCalled();
    });

    it('cancels a low-investment draft (e.g. "name" step) on greeting and restarts with the M1 welcome', async () => {
      jest.spyOn(ReservationService, 'getDraft').mockResolvedValue({
        conversationId: 'conv-greet',
        businessId: 'business-1',
        step: 'name',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      } as any);
      const deleteDraftSpy = jest.spyOn(ReservationService, 'deleteDraft').mockResolvedValue(undefined as any);
      jest.spyOn(SupabaseService, 'getActiveReservationByPhone').mockResolvedValue(null);
      jest.spyOn(SupabaseService, 'getBusinessById').mockResolvedValue({
        id: 'business-1',
        name: 'Restaurante Test',
      } as any);
      const startReservationSpy = jest
        .spyOn(ReservationService, 'startReservation')
        .mockResolvedValue({ conversationId: 'conv-greet', businessId: 'business-1', step: 'name' } as any);

      const handled = await (handler as any).handleGreeting(
        'Hola',
        'business-1',
        '5491234567890@s.whatsapp.net',
        'conv-greet'
      );

      // The stale draft is dropped, then a fresh reservation flow is started with the M1 welcome.
      expect(deleteDraftSpy).toHaveBeenCalledWith('conv-greet');
      expect(startReservationSpy).toHaveBeenCalledWith('conv-greet', 'business-1');
      expect(handled).toBe(true);
      expect(mockBaileysService.sendMessage).toHaveBeenCalledWith(
        'business-1',
        '5491234567890@s.whatsapp.net',
        expect.stringContaining('Soy el asistente de reservas de *Restaurante Test*')
      );
    });

    it('end-to-end: a stray "Hola" while mid-edit (confirm_slot) does not wipe the negotiated slot', async () => {
      // Reproduces the real-world bug: customer negotiated a new slot at
      // confirm_slot (editMode), a "Hola" arrives (e.g. in the same debounce
      // batch as another message), and the in-progress edit must survive it.
      jest.spyOn(ReservationService, 'getDraft').mockResolvedValue({
        conversationId: 'business-1-5491231231231',
        businessId: 'business-1',
        step: 'confirm_slot',
        editMode: true,
        existingReservationId: 'res-1',
        confirmSlotOrigin: 'time',
        scheduledDate: '2026-07-08',
        scheduledTime: '10:00',
        scheduledAt: '2026-07-08T13:00:00.000Z',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      } as any);

      jest.spyOn(SupabaseService, 'getBusinessById').mockResolvedValue({
        id: 'business-1',
        name: 'Restaurante Test',
        whatsapp_session_id: 'session-test-1',
      } as any);

      // confirm_slot isn't on the deterministic fast-path, so "Hola" would be
      // routed through the agent — stub it out so the test stays hermetic.
      jest.spyOn(agentService, 'generateResponse').mockResolvedValue({
        response: 'unused',
        action: null,
        conversationId: 'business-1-5491231231231',
        agent: { id: 'waitlist', name: 'Asistente de Reservas' },
        processingTime: 5,
      } as any);

      const deleteDraftSpy = jest.spyOn(ReservationService, 'deleteDraft').mockResolvedValue(undefined as any);
      const getActiveReservationSpy = jest.spyOn(SupabaseService, 'getActiveReservationByPhone');
      const startEditMenuSpy = jest.spyOn(ReservationService, 'startEditMenu');

      await (handler as any)._processMessage({
        from: '5491231231231@s.whatsapp.net',
        businessId: 'business-1',
        message: 'Hola',
        fromMe: false,
      });

      // The pending edit must survive: no cancellation, and the "you already
      // have a reservation" menu (which would overwrite the draft) never fires.
      expect(deleteDraftSpy).not.toHaveBeenCalled();
      expect(getActiveReservationSpy).not.toHaveBeenCalled();
      expect(startEditMenuSpy).not.toHaveBeenCalled();
    });
  });

  describe('M2 edit menu — edit date / time separately', () => {
    const scheduledEditMenuDraft = () => ({
      conversationId: 'conv-edit',
      businessId: 'business-1',
      step: 'edit_menu' as const,
      editMode: true,
      existingReservationId: 'res-edit',
      customerName: 'Ana',
      partySize: 3,
      // Wed 2026-07-08 21:00 BA -> 00:00Z next day
      scheduledAt: '2026-07-09T00:00:00.000Z',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    it('choice "2" edits only the day, pre-loading the existing time', async () => {
      const startEditDateSpy = jest
        .spyOn(ReservationService, 'startEditDate')
        .mockResolvedValue(scheduledEditMenuDraft() as any);

      const handled = await (handler as any).processDraftStep(
        scheduledEditMenuDraft(),
        '2',
        'conv-edit',
        'business-1',
        '5491234567890@s.whatsapp.net'
      );

      expect(handled).toBe(true);
      expect(startEditDateSpy).toHaveBeenCalledWith(
        'conv-edit',
        'business-1',
        'res-edit',
        expect.objectContaining({ customerName: 'Ana', partySize: 3 }),
        expect.objectContaining({ dateKey: '2026-07-08', hour: 21, minute: 0 })
      );
      expect(mockBaileysService.sendMessage).toHaveBeenCalledWith(
        'business-1',
        '5491234567890@s.whatsapp.net',
        expect.stringContaining('¿Qué día preferís?')
      );
    });

    it('choice "3" edits only the time, pre-loading the existing day', async () => {
      const startEditTimeSpy = jest
        .spyOn(ReservationService, 'startEditTime')
        .mockResolvedValue(scheduledEditMenuDraft() as any);

      const handled = await (handler as any).processDraftStep(
        scheduledEditMenuDraft(),
        '3',
        'conv-edit',
        'business-1',
        '5491234567890@s.whatsapp.net'
      );

      expect(handled).toBe(true);
      expect(startEditTimeSpy).toHaveBeenCalledWith(
        'conv-edit',
        'business-1',
        'res-edit',
        expect.objectContaining({ customerName: 'Ana', partySize: 3 }),
        '2026-07-08'
      );
      expect(mockBaileysService.sendMessage).toHaveBeenCalledWith(
        'business-1',
        '5491234567890@s.whatsapp.net',
        expect.stringContaining('¿A qué hora')
      );
    });
  });

  describe('M3 cancellation flow — cancel_menu / cancel_confirm', () => {
    const cancelMenuDraft = (step: 'cancel_menu' | 'cancel_confirm') => ({
      conversationId: 'conv-cancel',
      businessId: 'business-1',
      step,
      editMode: true,
      existingReservationId: 'res-cancel',
      customerName: 'Ana',
      partySize: 3,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    it('cancel_menu "1" starts the reschedule flow instead of cancelling', async () => {
      const startEditScheduleSpy = jest
        .spyOn(ReservationService, 'startEditSchedule')
        .mockResolvedValue(cancelMenuDraft('cancel_menu') as any);
      const updateStatusSpy = jest.spyOn(SupabaseService, 'updateReservationStatus');

      const handled = await (handler as any).processDraftStep(
        cancelMenuDraft('cancel_menu'),
        '1',
        'conv-cancel',
        'business-1',
        '5491234567890@s.whatsapp.net'
      );

      expect(handled).toBe(true);
      expect(startEditScheduleSpy).toHaveBeenCalledTimes(1);
      expect(updateStatusSpy).not.toHaveBeenCalled();
      expect(mockBaileysService.sendMessage).toHaveBeenCalledWith(
        'business-1',
        '5491234567890@s.whatsapp.net',
        expect.stringContaining('elegir una nueva fecha')
      );
    });

    it('cancel_menu "2" asks for a final confirmation before cancelling', async () => {
      jest.spyOn(ReservationService, 'saveDraft').mockResolvedValue(undefined as any);
      const updateStatusSpy = jest.spyOn(SupabaseService, 'updateReservationStatus');

      const draft = cancelMenuDraft('cancel_menu');
      const handled = await (handler as any).processDraftStep(
        draft,
        '2',
        'conv-cancel',
        'business-1',
        '5491234567890@s.whatsapp.net'
      );

      expect(handled).toBe(true);
      expect(draft.step).toBe('cancel_confirm');
      expect(updateStatusSpy).not.toHaveBeenCalled();
      expect(mockBaileysService.sendMessage).toHaveBeenCalledWith(
        'business-1',
        '5491234567890@s.whatsapp.net',
        expect.stringContaining('¿Estás seguro')
      );
    });

    it('cancel_confirm "1" cancels the reservation definitively', async () => {
      jest.spyOn(ReservationService, 'deleteDraft').mockResolvedValue(undefined as any);
      const updateStatusSpy = jest
        .spyOn(SupabaseService, 'updateReservationStatus')
        .mockResolvedValue(true);

      const handled = await (handler as any).processDraftStep(
        cancelMenuDraft('cancel_confirm'),
        '1',
        'conv-cancel',
        'business-1',
        '5491234567890@s.whatsapp.net'
      );

      expect(handled).toBe(true);
      expect(updateStatusSpy).toHaveBeenCalledWith('res-cancel', 'CANCELLED');
      expect(mockBaileysService.sendMessage).toHaveBeenCalledWith(
        'business-1',
        '5491234567890@s.whatsapp.net',
        expect.stringContaining('fue cancelada correctamente')
      );
    });

    it('cancel_confirm "2" keeps the reservation (no cancellation)', async () => {
      jest.spyOn(ReservationService, 'deleteDraft').mockResolvedValue(undefined as any);
      const updateStatusSpy = jest.spyOn(SupabaseService, 'updateReservationStatus');

      const handled = await (handler as any).processDraftStep(
        cancelMenuDraft('cancel_confirm'),
        '2',
        'conv-cancel',
        'business-1',
        '5491234567890@s.whatsapp.net'
      );

      expect(handled).toBe(true);
      expect(updateStatusSpy).not.toHaveBeenCalled();
      expect(mockBaileysService.sendMessage).toHaveBeenCalledWith(
        'business-1',
        '5491234567890@s.whatsapp.net',
        expect.stringContaining('sigue activa')
      );
    });
  });
});
