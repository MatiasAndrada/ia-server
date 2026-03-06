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
});
