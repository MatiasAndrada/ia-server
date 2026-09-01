/**
 * Catálogo em português (pt-BR).
 *
 * Espelha `esCatalog` chave por chave — o TypeScript garante que esteja completo
 * através da anotação `MessageCatalog`. O tom é pt-BR, não pt-PT: o tráfego real
 * de Puerto Iguazú é brasileiro (fronteira com Foz do Iguaçu).
 *
 * Notar que *CANCELAR* e *RESERVAR* são iguais em espanhol e português — o que
 * reduz a ambiguidade das palavras-chave entre os dois idiomas.
 */

import type { MessageCatalog } from './es.js';
import { buildLanguageMenuLines, NUMBER_EMOJI } from './es.js';

/** "uma hora" / "45 minutos" — a antecedência do lembrete é configurável. */
function countdownLabel(minutes: number): string {
  if (minutes < 60) {
    return `${minutes} minuto${minutes === 1 ? '' : 's'}`;
  }
  const hours = Math.round(minutes / 60);
  return `${hours === 1 ? 'uma' : hours} hora${hours === 1 ? '' : 's'}`;
}

/**
 * `checkBusinessHours` puede no devolver motivo. Antes se interpolaba directo y
 * el cliente llegaba a ver literalmente "❌ undefined"; estos helpers omiten el
 * motivo cuando no existe.
 */
function prefix(reason?: string): string {
  return reason ? `${reason} ` : '';
}

function prefixBlock(reason?: string): string {
  return reason ? `${reason}\n\n` : '';
}

/** "hoje 31/08 às 21:30" → "Hoje 31/08 às 21:30": o label abre a linha. */
function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Os dados operacionais da reserva em uma única linha — ver a nota em es.ts. */
function reservationLine(whenLabel: string, partySize: number, displayCode: string): string {
  const people = `${partySize} ${partySize === 1 ? 'pessoa' : 'pessoas'}`;
  return `📅 ${capitalize(whenLabel)} · 👥 ${people} · Código: *${displayCode}*`;
}

/** O evento vai em linha própria: o título é longo e quebraria a linha de dados. */
function eventLine(eventTitle?: string | null): string {
  return eventTitle ? `\n🎉 ${eventTitle}` : '';
}

export const ptCatalog: MessageCatalog = {
  // ============================
  // M0 — Seleção de idioma
  // ============================

  languageWelcomeMenu(businessName: string): string {
    return (
      `🌎 Bem-vindo ao *${businessName}*!\n\n` +
      `Em qual idioma você prefere fazer sua reserva?\n\n` +
      `${buildLanguageMenuLines()}\n\n` +
      `Responda com o *número* do idioma que preferir, ou continue escrevendo que eu acompanho você no seu idioma.`
    );
  },

  languageChanged(): string {
    return `✅ Pronto! Vamos continuar em português.`;
  },

  languageChangeHint(): string {
    return `_🌐 Para trocar de idioma, escreva o nome do idioma ou envie uma bandeira._`;
  },

  instantTurnLabel(): string {
    return `Hoje (turno atual)`;
  },

  // ============================
  // M1 — Nova reserva
  // ============================

  welcomeMenu(businessName: string, customerName?: string | null): string {
    const greeting = customerName ? `Olá, ${customerName}!` : `Olá!`;
    return (
      `${greeting} 👋 Tudo bem? Por aqui a gente te ajuda com suas reservas 😊 no ${businessName}.\n\n` +
      `O que você precisa?\n` +
      `${NUMBER_EMOJI[0]} Reservar uma mesa\n` +
      `${NUMBER_EMOJI[1]} Alterar ou cancelar uma reserva\n\n` +
      `Responda *1* ou *2*, ou simplesmente me conte o que você precisa.`
    );
  },

  welcomeMessage(businessName: string): string {
    return (
      `👋 Olá!\n` +
      `Sou o assistente de reservas do *${businessName}*.\n` +
      `Vou te ajudar a reservar sua mesa em poucos segundos.\n\n` +
      `Como você se chama? Me diga seu *nome e sobrenome*.`
    );
  },

  askPartySize(name: string): string {
    return (
      `✅ Perfeito, *${name}*.\n\n` +
      `Para quantas pessoas é a reserva?\n\n` +
      `Exemplo: 2, 4 ou 6 pessoas.`
    );
  },

  welcomeBackAskPartySize(customerName: string): string {
    return (
      `👋 Olá ${customerName}!\n\n` +
      `Para quantas pessoas é a reserva?\n\n` +
      `Exemplo: 2, 4 ou 6 pessoas.`
    );
  },

  askScheduleChoice(eventTitles: string[] = [], includeToday: boolean = true): string {
    const options: string[] = [];
    if (includeToday) options.push('Hoje (turno atual)');
    options.push('Outra data');
    options.push(...eventTitles);

    const lines = options.map((option, index) => `${NUMBER_EMOJI[index]} ${option}`).join('\n');
    const eventsNote = eventTitles.length > 0 ? ` Você também pode escolher um dos nossos eventos.` : '';

    return (
      `📅 A reserva é para...?\n\n` +
      `${lines}\n\n` +
      `Responda com o *número* da opção, ou me diga direto o dia (ex: "sexta-feira").${eventsNote}`
    );
  },

  askDayClosedToday(openDays?: string | null): string {
    if (openDays) {
      return (
        `❌ Hoje estamos fechados.\n\n` +
        `📅 Qual dia você prefere?\n` +
        `Abrimos: *${openDays}*.\n\n` +
        `Você pode dizer "amanhã", "sexta-feira", etc.`
      );
    }
    return (
      `❌ Hoje estamos fechados.\n\n` +
      `📅 Qual dia você prefere? Você pode dizer "amanhã", "sexta-feira", etc.`
    );
  },

  askDayClosedTodayWithSchedule(dayLines: string[]): string {
    if (dayLines.length === 0) {
      return (
        `⛔ Hoje estamos fechados e não encontrei disponibilidade nos próximos 7 dias.\n\n` +
        `Escreva para nós mais adiante para combinarmos sua reserva.`
      );
    }
    const list = dayLines.join('\n');
    return (
      `⛔ Hoje estamos fechados.\n\n` +
      `📅 Para qual destes dias você quer a reserva?\n\n` +
      `${list}\n\n` +
      `Responda com o dia que preferir (ex: "quinta" ou "quinta 09:15").`
    );
  },

  askDay(openDays?: string | null): string {
    if (openDays) {
      return (
        `📅 Qual dia você prefere?\n` +
        `Abrimos: *${openDays}*.\n\n` +
        `Você pode dizer "amanhã", "sexta-feira", etc.`
      );
    }
    return `📅 Qual dia você prefere? Você pode dizer "amanhã", "sexta-feira", etc.`;
  },

  otherDaysSchedule(dayLines: string[]): string {
    if (dayLines.length === 0) {
      return '📅 Por enquanto não tenho mais dias com disponibilidade para mostrar.';
    }
    const list = dayLines.map((line) => `• ${line}`).join('\n');
    return `📅 Estes são os horários dos próximos dias:\n\n${list}`;
  },

  askTime(dayLabel: string, hoursRange?: string | null): string {
    const hoursNote = hoursRange ? ` (horário: *${hoursRange}*)` : '';
    return `🕐 Que horas você gostaria de reservar para ${dayLabel}${hoursNote}?`;
  },

  askTodayTimeOpen(closeLabel: string | null): string {
    const closingNote = closeLabel ? ` (ficamos abertos até as *${closeLabel}*)` : '';
    return (
      `🕐 Que horas você gostaria da reserva de hoje?${closingNote}\n\n` +
      `Escreva o horário (ex: "21:00" ou "nove e meia"), ou responda *agora* se quiser para o turno atual.`
    );
  },

  /**
   * Confirma a escolha do evento e leva ao resumo. Enviado DEPOIS das fotos,
   * para que o texto seja a última mensagem do bloco.
   */
  eventSelected(title: string, description: string | null, whenLabel: string): string {
    const descriptionBlock = description ? `${description}\n\n` : '';
    return (
      `🎉 *${title}*\n\n` +
      `${descriptionBlock}` +
      `📅 ${whenLabel}\n\n` +
      `Ótimo, vamos seguir com a sua reserva para o evento.`
    );
  },

  /** O evento deixou de estar disponível entre a exibição do menu e a resposta. */
  eventNoLongerAvailable(title: string): string {
    return `😔 *${title}* não está mais disponível. Escolha outra opção, por favor.`;
  },

  /** Menu de edição do resumo quando a reserva é para um evento: o evento fixa data e horário. */
  summaryEditMenuEvent(): string {
    return (
      `O que você quer modificar?\n\n` +
      `1️⃣ Quantidade de pessoas\n` +
      `2️⃣ Escolher outra data ou evento\n\n` +
      `Responda com o *número* da opção.`
    );
  },

  reservationSummary(
    name: string,
    partySize: number,
    whenLabel: string,
    fullName: string = name,
    eventTitle?: string | null
  ): string {
    const eventLine = eventTitle ? `🎉 Evento: ${eventTitle}\n` : '';
    return (
      `📋 Antes de confirmar, verifique se os dados estão corretos:\n\n` +
      `👤 Nome: ${fullName}\n` +
      `👥 Pessoas: ${partySize}\n` +
      `${eventLine}` +
      `📅 Data e hora: ${whenLabel}\n\n` +
      `Está tudo certo?\n\n` +
      `1️⃣ Confirmar reserva\n` +
      `2️⃣ Alterar a reserva`
    );
  },

  summaryEditMenu(): string {
    return (
      `O que você quer alterar?\n\n` +
      `1️⃣ Quantidade de pessoas\n` +
      `2️⃣ Data\n` +
      `3️⃣ Horário\n\n` +
      `Responda com o *número* da opção.`
    );
  },

  reservationConfirmed(
    name: string,
    partySize: number,
    whenLabel: string,
    displayCode: string,
    eventTitle?: string | null
  ): string {
    return (
      `✅ Reserva confirmada, ${name}!\n` +
      `${reservationLine(whenLabel, partySize, displayCode)}${eventLine(eventTitle)}\n\n` +
      `Esperamos por você 👋`
    );
  },

  reservationReceived(
    partySize: number,
    whenLabel: string,
    displayCode: string,
    eventTitle?: string | null
  ): string {
    return (
      `Pronto ✅\n` +
      `${reservationLine(whenLabel, partySize, displayCode)}${eventLine(eventTitle)}\n` +
      `Aviso assim que o restaurante confirmar.`
    );
  },

  // ============================
  // M2 — Alterar uma reserva
  // ============================

  editMenu(
    partySize: number,
    whenLabel: string,
    displayCode: string,
    statusLabel: string,
    customerName?: string | null,
    eventTitle?: string | null
  ): string {
    const greeting = customerName ? `👋 Olá ${customerName}! O que você precisa hoje?\n\n` : '';
    const eventSuffix = eventTitle ? ` — 🎉 ${eventTitle}` : '';
    return (
      `${greeting}📋 Você tem 1 reserva ativa:\n` +
      `• ${partySize} pessoas, ${whenLabel} (${displayCode}) ${statusLabel}${eventSuffix}\n\n` +
      `O que você quer fazer?\n\n` +
      `1️⃣ Quantidade de pessoas\n` +
      `2️⃣ Data\n` +
      `3️⃣ Horário\n` +
      `4️⃣ Criar outra reserva\n\n` +
      `Responda com o *número* da opção.\n\n` +
      `_Para cancelar sua reserva escreva *CANCELAR*._`
    );
  },

  editMenuInvalidChoice(): string {
    return `❌ Por favor responda com *1*, *2*, *3* ou *4*, conforme a opção escolhida.`;
  },

  partySizeUpdated(partySize: number): string {
    return `✅ Pronto! Sua reserva foi atualizada para *${partySize}* pessoas.`;
  },

  partySizeUpdateFailed(): string {
    return `❌ Não foi possível atualizar a quantidade. Por favor tente novamente.`;
  },

  scheduleUpdated(whenLabel: string): string {
    return `✅ Pronto! Sua reserva foi atualizada para ${whenLabel}.`;
  },

  scheduleRevertedToInstant(): string {
    return `✅ Pronto! Sua reserva volta a ser para o turno atual.`;
  },

  // ============================
  // M3 — Cancelar uma reserva
  // ============================

  cancelMenu(partySize: number, whenLabel: string, displayCode: string): string {
    return (
      `📋 Encontrei uma reserva ativa.\n\n` +
      `👥 Pessoas: *${partySize}*\n` +
      `📅 Data e hora: ${whenLabel}\n` +
      `📁 Código: *${displayCode}*\n\n` +
      `O que você gostaria de fazer?\n\n` +
      `1️⃣ Remarcar a reserva\n` +
      `2️⃣ Cancelar definitivamente`
    );
  },

  cancelDirectConfirmPrompt(partySize: number, whenLabel: string, displayCode: string): string {
    return (
      `📋 Encontrei sua reserva de *${partySize}* pessoas para ${whenLabel} (código *${displayCode}*).\n\n` +
      `Vamos cancelar esta reserva?\n\n` +
      `1️⃣ Sim, cancelar\n` +
      `2️⃣ Voltar`
    );
  },

  activeReservationsMenu(
    reservations: {
      index: number;
      partySize: number;
      whenLabel: string;
      displayCode: string | null;
      statusLabel: string;
      eventTitle?: string | null;
    }[],
    action: 'edit' | 'cancel' | 'view' = 'view'
  ): string {
    const reservationsList = reservations
      .map((reservation) => {
        const codeText = reservation.displayCode ? ` (${reservation.displayCode})` : '';
        const eventSuffix = reservation.eventTitle ? ` — 🎉 ${reservation.eventTitle}` : '';
        return `*${reservation.index}* - ${reservation.partySize} pessoas, ${reservation.whenLabel}${codeText} — ${reservation.statusLabel}${eventSuffix}`;
      })
      .join('\n');

    const prompt =
      action === 'cancel'
        ? `Responda com o *número* da reserva que você quer cancelar.`
        : action === 'edit'
          ? `Responda com o *número* da reserva que você quer alterar.`
          : `Responda com o *número* da reserva para ver as opções de alteração ou cancelamento.`;

    return (
      `📋 Você tem várias reservas ativas:\n\n` +
      `${reservationsList}\n\n` +
      `${prompt}\n` +
      `Ou escreva *RESERVAR* para criar outra reserva.`
    );
  },

  activeReservationSelectionInvalid(): string {
    return `❌ Não reconheci essa opção. Responda com o número da reserva que você quer gerenciar ou escreva *RESERVAR* para criar outra.`;
  },

  cancelMenuInvalidChoice(): string {
    return `❌ Responda *1* para remarcar ou *2* para cancelar definitivamente.`;
  },

  rescheduleIntro(): string {
    return `Perfeito 👍\nVamos começar escolhendo uma nova data.`;
  },

  cancelConfirmPrompt(): string {
    return (
      `Tem certeza de que quer cancelar sua reserva?\n\n` +
      `1️⃣ Sim, cancelar\n` +
      `2️⃣ Não, manter a reserva`
    );
  },

  cancelConfirmInvalidChoice(): string {
    return `❌ Responda *1* para cancelar a reserva ou *2* para mantê-la.`;
  },

  reservationCancelled(): string {
    return (
      `✅ Sua reserva foi cancelada com sucesso.\n\n` +
      `Esperamos receber você novamente em breve.\n\n` +
      `Quando quiser fazer uma nova reserva, escreva: *RESERVAR*`
    );
  },

  reservationKept(): string {
    return `👍 Perfeito! Sua reserva continua ativa exatamente como estava. Posso ajudar em mais alguma coisa?`;
  },

  cancelFailed(): string {
    return `❌ Não foi possível cancelar a reserva. Por favor entre em contato diretamente com o restaurante.`;
  },

  reservationOverlapConflict(
    requestedWhenLabel: string,
    conflictingWhenLabel: string,
    conflictingDisplayCode: string | null,
    conflictingStatusLabel: string
  ): string {
    const displayCodeText = conflictingDisplayCode ? ` (código *${conflictingDisplayCode}*)` : '';
    return (
      `⚠️ Não consigo criar a reserva para ${requestedWhenLabel} porque ela se sobrepõe a outra reserva ativa para ${conflictingWhenLabel}` +
      `${displayCodeText} com status *${conflictingStatusLabel}*.` +
      `\n\nDeve haver pelo menos 120 minutos entre as reservas para evitar sobreposições.` +
      `\n\nSe quiser, responda *CANCELAR* para anulá-la e depois criar uma nova.`
    );
  },

  noActiveReservation(): string {
    return `Não encontrei nenhuma reserva ativa. Posso ajudar em mais alguma coisa?`;
  },

  newReservationOverlapReminder(
    conflictingWhenLabel: string,
    conflictingDisplayCode: string | null,
    conflictingStatusLabel: string
  ): string {
    const displayCodeText = conflictingDisplayCode ? ` (código *${conflictingDisplayCode}*)` : '';
    return (
      `⚠️ Sua nova reserva se sobrepõe a uma reserva ativa para ${conflictingWhenLabel}` +
      `${displayCodeText} com status *${conflictingStatusLabel}*.` +
      `\n\nNão posso criá-la porque deve haver pelo menos 120 minutos entre reservas.` +
      `\n\nSe quiser, responda *CANCELAR* para anulá-la e depois criar uma nova.`
    );
  },

  // ============================
  // Mensagens multi-ação (cancelar/consultar várias reservas em um turno)
  // ============================

  cancelTargetNotFound(hasActiveReservations: boolean): string {
    return hasActiveReservations
      ? `⚠️ Não consegui identificar qual reserva cancelar; escreva *CANCELAR* e mostro suas reservas.`
      : `⚠️ Não encontrei uma reserva ativa para cancelar.`;
  },

  reservationCancelledInline(whenLabel: string, displayCode: string | null): string {
    const codeText = displayCode ? ` (código *${displayCode}*)` : '';
    return `✅ Cancelei sua reserva para ${whenLabel}${codeText}.`;
  },

  cancelActionFailed(): string {
    return `❌ Não consegui cancelar uma das reservas. Tente novamente.`;
  },

  noActiveReservationsShort(): string {
    return `Você não tem reservas ativas neste momento.`;
  },

  // ============================
  // M8 — Horários indisponíveis
  // ============================

  timeNotAvailable(reason: string, nextSlotTime: string): string {
    return (
      `Esse horário não está disponível. ${reason}\n\n` +
      `🕐 O próximo horário disponível nesse dia é às *${nextSlotTime}*.\n\n` +
      `Reservamos para esse horário? Responda *sim* ou *não*.`
    );
  },

  noMoreSlotsToday(reason: string): string {
    return `Esse horário não está disponível. ${reason} Não há mais turnos disponíveis nesse dia. Você quer escolher outro horário ou outro dia?`;
  },

  suggestNextSlot(slotLabel: string, reason?: string | null): string {
    const prefix = reason ? `❌ ${reason}\n\n` : '';
    return (
      `${prefix}O turno disponível mais próximo é *${slotLabel}*.\n\n` +
      `Reservamos para esse momento? Responda *sim* para confirmar, ou me diga outro dia ou horário se preferir.`
    );
  },

  // ============================
  // M8b — Bloqueios de datas configurados pelo restaurante
  // ============================

  dateBlocked(dayLabel: string, reasonMessage?: string | null): string {
    if (reasonMessage) {
      return `❌ ${reasonMessage}\n\nVocê quer escolher outra data?`;
    }
    return (
      `❌ Desculpe, em *${dayLabel}* não estamos aceitando reservas.\n\n` +
      `Você quer escolher outra data?`
    );
  },

  futureReservationsBlockedToday(): string {
    return (
      `❌ Por hoje não estamos aceitando reservas para turnos mais tarde — apenas para o turno que está acontecendo agora.\n\n` +
      `Você quer entrar na fila do turno atual, ou reservar para outro dia?`
    );
  },

  // ============================
  // M9 — Validação de dados
  // ============================

  invalidDate(): string {
    return `Não consegui entender a data. Você pode escrevê-la novamente? Você pode dizer "hoje", "amanhã" ou um dia da semana (ex: "sexta-feira").`;
  },

  invalidTime(): string {
    return `Você pode escrever o horário novamente? Por exemplo: "21:00", "9 da noite" ou "nove e meia".`;
  },

  invalidPartySize(): string {
    return (
      `A quantidade de pessoas deve ser um número.\n\n` +
      `Exemplo: 2, 4 ou 6 pessoas.\n\n` +
      `_(Para cancelar escreva *cancelar* ou *sair*)_`
    );
  },

  invalidName(): string {
    return `Não reconheci isso como um nome. Qual é o seu nome para a reserva?`;
  },

  nameChanged(name: string): string {
    return (
      `✅ Pronto! Alterei seu nome para *${name}*.\n\n` +
      `Para quantas pessoas é a reserva?\n\n` +
      `Exemplo: 2, 4 ou 6 pessoas.`
    );
  },

  askPartySizeShort(): string {
    return `Para quantas pessoas é a reserva?\n\nExemplo: 2, 4 ou 6 pessoas.`;
  },


  // ============================
  // Guards e prompts de fluxo
  // ============================

  invalidNameRetry(): string {
    return `Não reconheci isso como um nome. Qual é o seu nome para continuarmos com a reserva?`;
  },

  askCorrectName(): string {
    return `Qual é o seu nome correto para continuarmos com a reserva?`;
  },

  askCorrectNameField(field: 'full' | 'lastName'): string {
    return field === 'lastName'
      ? `Qual é o seu sobrenome correto?`
      : `Qual é o seu nome e sobrenome corretos?`;
  },

  invalidLastNameRetry(): string {
    return `Não reconheci esse nome. Pode repetir, por favor?`;
  },

  noStoredCustomerData(): string {
    return `Ainda não tenho seus dados salvos. Seu nome será guardado quando você fizer uma reserva. 😊`;
  },

  customerNameUpdated(fullName: string): string {
    return `✅ Pronto, atualizei seu nome. Agora você aparece como *${fullName}*.`;
  },

  closedNoAvailability(): string {
    return `❌ Estamos fechados neste momento e não encontrei disponibilidade nos próximos 60 dias.`;
  },

  closedSuggestNextSlot(slotLabel: string): string {
    return `❌ Estamos fechados neste momento.\n\nO próximo horário disponível é *${slotLabel}*.\n\nReservamos para esse horário? Responda *sim* ou *não*.`;
  },

  outOfWindowPrefix(): string {
    return `Por enquanto só posso aceitar reservas dentro dos próximos 60 dias. `;
  },

  outOfWindowAskDay(): string {
    return `Por enquanto só posso aceitar reservas dentro dos próximos 60 dias. Para qual dia você quer?`;
  },

  scheduleChoiceInvalid(optionCount: number = 2): string {
    if (optionCount <= 2) {
      return `❌ Responda *1* para agora ou *2* para escolher dia e horário.`;
    }
    return `❌ Responda com um *número* de *1* a *${optionCount}*, ou me diga direto que dia você quer.`;
  },

  didntUnderstandTimeSuggest(slotTime: string): string {
    return `Não entendi o horário. O primeiro turno disponível nesse dia é às *${slotTime}*.\n\nReservamos para esse horário? Responda *sim* ou *não*.`;
  },

  hoursRejectedAskOther(reason: string | undefined): string {
    return `❌ ${prefix(reason)}Para qual outro dia e horário você quer?`;
  },

  hoursRejectedSuggestSlot(reason: string | undefined, slotTime: string): string {
    return `❌ ${prefixBlock(reason)}O próximo horário disponível nesse dia é às *${slotTime}*. Reservamos para esse horário? Responda *sim* ou *não*.`;
  },

  hoursRejectedNoMoreSlots(reason: string | undefined): string {
    return `❌ ${prefix(reason)}Não há mais turnos disponíveis nesse dia. Você quer escolher outro horário ou outro dia?`;
  },

  confirmSlotPrompt(slotLabel: string, hoursNote: string): string {
    return `Confirmamos a reserva para *${slotLabel}*?${hoursNote}\n\nResponda *sim* ou *não*.`;
  },

  dayClosedAskOtherDay(reason: string | undefined): string {
    return `❌ ${prefix(reason)}Para qual outro dia você quer reservar?`;
  },

  carriedTimeHoursNote(hoursRange: string): string {
    return `\n\nNesse dia atendemos das *${hoursRange}*. Me diga outro horário se preferir.`;
  },

  didNotUnderstandDayAndTime(): string {
    return `❌ Não entendi bem o dia e o horário. Para qual dia e horário você quer?`;
  },

  askTimeAgain(): string {
    return `Que horário você prefere então?`;
  },

  confirmSlotYesNoReminder(slotLabel: string | null): string {
    return slotLabel
      ? `Responda *sim* ou *não*: confirmamos a reserva para *${slotLabel}*? (Se preferir outro dia ou horário, é só me dizer.)`
      : `Responda *sim* para confirmar esse horário ou *não* para escolher outro.`;
  },

  reservationRescheduled(whenLabel: string): string {
    return `✅ Pronto! Sua reserva foi atualizada para ${whenLabel}.`;
  },

  reservationUpdateFailed(): string {
    return `❌ Não foi possível atualizar sua reserva. Por favor tente novamente.`;
  },

  askNewPartySize(): string {
    return `Para quantas pessoas você quer alterar a reserva?\n\nExemplo: 2, 4 ou 6 pessoas.`;
  },

  weekdayAmbiguityPrompt(weekdayLabel: string, nextLabel: string): string {
    return `Você quer dizer *hoje, ${weekdayLabel}*, ou *${nextLabel}* da semana que vem?\n\nResponda *1* para hoje ou *2* para a semana que vem.`;
  },

  weekdayAmbiguityInvalid(weekday: string): string {
    return `Não entendi. Responda *1* para hoje ou *2* para a ${weekday} que vem.`;
  },

  weekdayDayMismatchPrompt(weekdayLabel: string, requestedDayNumber: number, nearestLabel: string): string {
    return `Por enquanto só posso aceitar reservas dentro dos *próximos 60 dias*, então não consigo agendar para *${weekdayLabel} dia ${requestedDayNumber}*.\n\nVocê quer que seja *${nearestLabel}* (a próxima ${weekdayLabel}) no lugar?\n\nResponda *sim* ou *não*.`;
  },

  weekdayDayMismatchInvalid(nearestLabel: string): string {
    return `Não entendi. Responda *sim* para ${nearestLabel} ou *não* para escolher outro dia.`;
  },

  timeAlreadyPassedSuggestTomorrow(timeLabel: string, tomorrowLabel: string): string {
    return `Esse horário já passou hoje. Podemos reservar para amanhã às *${timeLabel}* (${tomorrowLabel})?\n\nResponda *sim* ou *não*.`;
  },

  timeAlreadyPassed(): string {
    return `❌ Esse horário já passou. Me diga outro horário, ou outro dia se preferir.`;
  },

  noActiveReservationsInquiry(): string {
    return `Você não tem reservas ativas neste momento. Se quiser, pode criar uma nova escrevendo *RESERVAR*.`;
  },

  firstContactNoReservations(businessName: string): string {
    return (
      `👋 Olá! Sou o assistente de reservas do *${businessName}*.\n\n` +
      `Você ainda não tem nenhuma reserva conosco — é a primeira vez que conversamos.\n\n` +
      `Posso te ajudar a *reservar uma mesa* e, mais adiante, *alterá-la* ou *cancelá-la*.\n\n` +
      `Quer reservar? Escreva *RESERVAR* e começamos.`
    );
  },

  reservationConfirmedNotice(
    name: string,
    partySize: number,
    displayCode: string,
    whenLabel: string,
    eventTitle?: string | null
  ): string {
    return (
      `✅ Reserva confirmada, ${name}!\n` +
      `${reservationLine(whenLabel, partySize, displayCode)}${eventLine(eventTitle)}\n\n` +
      `Esperamos por você 👋`
    );
  },

  reservationRegisteredNotice(
    partySize: number,
    displayCode: string,
    whenLabel: string,
    eventTitle?: string | null
  ): string {
    return (
      `Pronto ✅\n` +
      `${reservationLine(whenLabel, partySize, displayCode)}${eventLine(eventTitle)}\n` +
      `Aviso assim que o restaurante confirmar.`
    );
  },

  reservationUpcomingReminder(
    name: string,
    partySize: number,
    whenLabel: string,
    displayCode: string,
    minutesUntil: number
  ): string {
    return (
      `⏰ Lembrete da sua reserva\n\n` +
      `👤 Nome: ${name}\n` +
      `👥 Pessoas: ${partySize}\n` +
      `🗓️ ${whenLabel}\n` +
      `📁 Código da reserva: *${displayCode}*\n\n` +
      `Falta ${countdownLabel(minutesUntil)}. Esperamos por você!\n\n` +
      `_Se não puder vir, responda *CANCELAR* e liberamos a mesa._`
    );
  },

  reservationArrivalReminder(
    whenLabel: string,
    displayCode: string,
    minutesUntil: number
  ): string {
    return (
      `🔔 Faltam ${countdownLabel(minutesUntil)} para a sua reserva\n\n` +
      `🗓️ ${whenLabel}\n` +
      `📁 Código da reserva: *${displayCode}*\n\n` +
      `Você já deveria estar por perto. Esperamos por você!`
    );
  },

  /** O comércio excluiu um evento, cancelando suas reservas. Ver es.ts. */
  eventCancelledByBusiness(
    name: string,
    eventTitle: string,
    displayCode: string,
    whenLabel: string | null
  ): string {
    return (
      `❌ O evento *${eventTitle}* foi cancelado pelo restaurante.\n\n` +
      `Sua reserva para esse evento fica sem efeito.\n\n` +
      `👤 Nome: ${name}\n` +
      (whenLabel ? `🗓️ Era para: ${whenLabel}\n` : '') +
      `📁 Código da reserva: *${displayCode}*\n\n` +
      `Lamentamos o inconveniente.\n` +
      `_Se quiser reservar para outro momento, escreva para nós e resolvemos._`
    );
  },

  reservationCancelledByBusiness(
    name: string,
    displayCode: string,
    whenLabel: string | null
  ): string {
    return (
      `❌ Sua reserva foi cancelada pelo restaurante.\n\n` +
      `👤 Nome: ${name}\n` +
      (whenLabel ? `🗓️ Era para: ${whenLabel}\n` : '') +
      `📁 Código da reserva: *${displayCode}*\n\n` +
      `Lamentamos o inconveniente.\n` +
      `_Se quiser reservar para outro momento, escreva para nós e resolvemos._`
    );
  },

  tableReadyNotice(): string {
    return (
      `🍽️ Sua mesa está pronta!\n` +
      `Você pode ocupá-la nos próximos 20 minutos.\n\n` +
      `Depois desse tempo, a reserva pode ser liberada.`
    );
  },

  postReservationCourtesyReply(reservationRef: string, isPending: boolean, isGratitude: boolean): string {
    if (isPending) {
      return isGratitude
        ? `De nada! 🙌\n\nSua reserva${reservationRef} continua pendente de confirmação. Assim que confirmarem, avisamos por aqui.`
        : `Perfeito! 🙌\n\nSua reserva${reservationRef} continua pendente de confirmação. Assim que confirmarem, avisamos por aqui.`;
    }
    return isGratitude
      ? `De nada! 🙌\n\nSua reserva${reservationRef} já está confirmada. Se precisar de mais alguma coisa, estou à disposição.`
      : `Ótimo! 🙌\n\nSua reserva${reservationRef} já está confirmada. Se precisar de mais alguma coisa, estou à disposição.`;
  },

  // ============================
  // M11 — Boas-vindas no restaurante
  // ============================

  // ============================
  // Mensagens de fluxo / guards
  // ============================

  askName(): string {
    return `Qual é o seu nome e sobrenome para a reserva?`;
  },

  askNameAgain(): string {
    return `Qual é o seu nome e sobrenome para continuarmos com a reserva?`;
  },

  askLastName(firstName: string): string {
    return `Obrigado, *${firstName}*. Qual é o seu sobrenome?`;
  },

  askLastNameAgain(): string {
    return `Não reconheci o sobrenome. Pode repetir, por favor?`;
  },

  processCancelled(): string {
    return `✅ Processo cancelado. Você pode começar de novo quando quiser.`;
  },

  tooManyInvalidAttempts(): string {
    return `❌ Muitas tentativas inválidas. O processo foi cancelado. Você pode começar de novo quando quiser.`;
  },

  confirmSummaryInvalidChoice(): string {
    return `❌ Responda *1* para confirmar a reserva ou *2* para alterá-la.`;
  },

  // ============================
  // Guards de escopo
  // ============================

  reservationIntro(businessName: string): string {
    return `Olá! 👋 Sou o assistente do ${businessName} e estou aqui para fazer reservas. Qual é o seu nome?`;
  },

  reservationOffTopic(businessName: string): string {
    return `Olá 😊 Só posso ajudar com perguntas relacionadas a reservas do “${businessName}” para o turno atual. Você quer fazer uma reserva?`;
  },

  reservationOutOfWindow(businessName: string): string {
    return `Olá 😊 No “${businessName}” por enquanto só posso aceitar reservas dentro dos próximos 60 dias. Você quer escolher um dia mais próximo?`;
  },

  inactiveFallback(): string {
    return `Desculpe, nosso serviço de WhatsApp não está disponível no momento. Por favor tente mais tarde.`;
  },

  genericError(): string {
    return `Ops, tive um problema ao processar sua mensagem. Pode enviar de novo?`;
  },
};
