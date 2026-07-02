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
      expect.stringContaining('Mientras esta reserva siga activa, no puedo crear una nueva')
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

    jest
      .spyOn(ReservationService, 'getDraft')
      .mockResolvedValue(null);

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
      .mockResolvedValueOnce(activeReservation) // cancel path on second message
      .mockResolvedValueOnce(null) // policy check on third message
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

    await (handler as any)._processMessage({
      from: '5495555555555@s.whatsapp.net',
      businessId: 'business-1',
      message: 'cancelar mi reserva',
      fromMe: false,
    });

    await (handler as any)._processMessage({
      from: '5495555555555@s.whatsapp.net',
      businessId: 'business-1',
      message: 'quiero reservar',
      fromMe: false,
    });

    // Third message ("quiero reservar") now matches the deterministic reservation
    // opt-in fast path (see isReservationOptInMessage), so it starts the draft directly
    // instead of round-tripping through the agent's CREATE_RESERVATION action —
    // one fewer getActiveReservationByPhone call than the old agent-driven path.
    expect(getActiveSpy).toHaveBeenCalledTimes(3);
    expect(cancelSpy).toHaveBeenCalledWith('entry-7', 'CANCELLED');
    expect(startReservationSpy).toHaveBeenCalledTimes(1);

    const sentMessages = mockBaileysService.sendMessage.mock.calls.map((call) => call[2]);
    expect(sentMessages.some((msg) => msg.includes('ya tenés una reserva para hoy'))).toBe(true);
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
      '¡Hola! 👋 Soy el asistente de Restaurante Test y estoy para generar reservas. ¿Cuál es tu nombre?'
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
      expect.stringContaining('¿Para el turno actual (ahora) o para otro día de la semana?')
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
      expect.stringContaining('¿Para el turno actual (ahora) o para otro día de la semana?')
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
      expect.stringContaining('¿Para el turno actual (ahora) o para otro día de la semana?')
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
      expect.stringContaining('¿Para el turno actual (ahora) o para otro día de la semana?')
    );
  });

  describe('schedule_choice / date / time steps', () => {
    // Thursday 2026-07-02, 12:00 BA wall-clock time.
    const NOW_BA = new Date('2026-07-02T12:00:00.000Z');

    beforeEach(() => {
      jest.spyOn(ReservationDatetime, 'nowInBuenosAires').mockReturnValue(NOW_BA);
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

    it('creates the reservation immediately when choosing "1" and the business is open', async () => {
      jest.spyOn(SupabaseService, 'getBusinessById').mockResolvedValue({
        id: 'business-1',
        name: 'Restaurante Test',
        weekly_hours: { thu: { closed: false, shifts: [{ open: '08:00', close: '23:00' }] } },
      } as any);

      const setInstantScheduleSpy = jest
        .spyOn(ReservationService, 'setInstantSchedule')
        .mockResolvedValue(scheduleChoiceDraft() as any);
      const createAndNotifySpy = jest
        .spyOn(handler as any, 'createAndNotifyReservation')
        .mockResolvedValue(undefined);

      const handled = await (handler as any).processDraftStep(
        scheduleChoiceDraft(),
        '1',
        'conv-sched',
        'business-1',
        '5491234567890@s.whatsapp.net'
      );

      expect(handled).toBe(true);
      expect(setInstantScheduleSpy).toHaveBeenCalledWith('conv-sched');
      expect(createAndNotifySpy).toHaveBeenCalledWith(
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
        '¿A qué hora el viernes 03/07?'
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
      const createAndNotifySpy = jest
        .spyOn(handler as any, 'createAndNotifyReservation')
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
      expect(createAndNotifySpy).toHaveBeenCalledWith(
        'conv-sched',
        'business-1',
        '5491234567890@s.whatsapp.net'
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
  });
});
