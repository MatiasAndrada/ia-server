import { WhatsAppHandler } from '../../services/whatsapp-handler.service';
import { SupabaseService } from '../../services/supabase.service';
import { ReservationService } from '../../services/reservation.service';
import { agentService } from '../../services/agent.service';
import { agentRegistry } from '../../agents';

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
      .spyOn(SupabaseService, 'getActiveTodayReservationByPhone')
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
      .spyOn(SupabaseService, 'getActiveTodayReservationByPhone')
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
      .spyOn(SupabaseService, 'getActiveTodayReservationByPhone')
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
      .spyOn(SupabaseService, 'getActiveTodayReservationByPhone')
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
      .spyOn(SupabaseService, 'getActiveTodayReservationByPhone')
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
      .spyOn(SupabaseService, 'getActiveTodayReservationByPhone')
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
      .spyOn(SupabaseService, 'getActiveTodayReservationByPhone')
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

    expect(getActiveSpy).toHaveBeenCalledTimes(4);
    expect(cancelSpy).toHaveBeenCalledWith('entry-7', 'CANCELLED');
    expect(startReservationSpy).toHaveBeenCalledTimes(1);

    const sentMessages = mockBaileysService.sendMessage.mock.calls.map((call) => call[2]);
    expect(sentMessages.some((msg) => msg.includes('ya tenés una reserva para hoy'))).toBe(true);
    expect(sentMessages.some((msg) => msg.includes('fue cancelada correctamente'))).toBe(true);
    expect(sentMessages.some((msg) => msg.includes('¿cuál es tu nombre?'))).toBe(true);
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
      .spyOn(SupabaseService, 'getActiveTodayReservationByPhone')
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
      .spyOn(SupabaseService, 'getActiveTodayReservationByPhone')
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
      .spyOn(SupabaseService, 'getActiveTodayReservationByPhone')
      .mockResolvedValue(null);

    jest
      .spyOn(agentService, 'generateResponse')
      .mockResolvedValue({
        response: '¡Hola! 👋 Soy el asistente de Restaurante Test y estoy para generar reservas. ¿Cuál es tu nombre?',
        action: 'CREATE_RESERVATION',
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

    expect(startReservationSpy).toHaveBeenCalledWith('business-1-5493213213213', 'business-1');
    expect(mockBaileysService.sendMessage).toHaveBeenCalledWith(
      'business-1',
      '5493213213213@s.whatsapp.net',
      '¡Hola! 👋 Soy el asistente de Restaurante Test y estoy para generar reservas. ¿Cuál es tu nombre?'
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
      .spyOn(SupabaseService, 'getActiveTodayReservationByPhone')
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

    const createAndNotifySpy = jest
      .spyOn(handler as any, 'createAndNotifyReservation')
      .mockResolvedValue(undefined);

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
    expect(createAndNotifySpy).toHaveBeenCalledWith(
      'business-1-5496546546546',
      'business-1',
      '5496546546546@s.whatsapp.net'
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

  it('blocks specific-time messages during party_size without counting them as invalid attempts', async () => {
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

    const saveDraftSpy = jest
      .spyOn(ReservationService, 'saveDraft')
      .mockResolvedValue(undefined as any);

    const createReservationSpy = jest
      .spyOn(ReservationService, 'createReservation')
      .mockResolvedValue({ success: true } as any);

    await (handler as any)._processMessage({
      from: '5498888888888@s.whatsapp.net',
      businessId: 'business-1',
      message: 'A las 22:30 somos 4',
      fromMe: false,
    });

    expect(saveDraftSpy).not.toHaveBeenCalled();
    expect(createReservationSpy).not.toHaveBeenCalled();
    expect(mockBaileysService.sendMessage).toHaveBeenCalledWith(
      'business-1',
      '5498888888888@s.whatsapp.net',
      'Hola 😊 Por ahora solo puedo ayudarte con reservas instantáneas para el turno actual en “Restaurante Test”. Todavía no puedo tomar reservas para una hora específica. ¿Querés hacer una reserva?'
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

    const createAndNotifySpy = jest
      .spyOn(handler as any, 'createAndNotifyReservation')
      .mockResolvedValue(undefined);

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
    expect(createAndNotifySpy).toHaveBeenCalledWith(
      'conv-10',
      'business-1',
      '5491010101010@s.whatsapp.net'
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

    const createAndNotifySpy = jest
      .spyOn(handler as any, 'createAndNotifyReservation')
      .mockResolvedValue(undefined);

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
    expect(createAndNotifySpy).toHaveBeenCalledWith(
      'conv-11',
      'business-1',
      '5491110101010@s.whatsapp.net'
    );
  });
});
