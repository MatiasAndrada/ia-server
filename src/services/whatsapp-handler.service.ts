import { BaileysService } from './baileys.service.js';
import { SupabaseService } from './supabase.service.js';
import { RedisConfig } from '../config/redis.js';
import { BaileysMessage, Business } from '../types/index.js';
import { logger, logEvent } from '../utils/logger.js';
import { withLogContext } from '../utils/log-context.js';
import { normalizePhone } from '../utils/phone.js';
import {
  withTurnStats,
  recordOutbound,
} from '../utils/turn-stats.js';
import {
  runWithLanguage,
  currentLanguage,
  getTemplates,
  SupportedLanguage,
  DEFAULT_LANGUAGE,
} from '../i18n/index.js';
import {
  cacheDetectedLanguage,
  persistLanguage,
  resolveLanguage,
} from '../i18n/language-store.js';
import {
  detectLanguage,
  parseLanguageMenuChoice,
  DETECTION_THRESHOLD,
} from '../i18n/detect.js';
import { isMultilingualGreeting } from '../i18n/keywords.js';
import { handleTurn } from '../agent/orchestrator.js';
import {
  appendExchange,
  clearOnboardingStep,
  loadHistory,
  loadOnboardingStep,
  setOnboardingStep,
} from '../agent/state.js';
import {
  isObviouslyGibberish,
  looksLikePersonName,
} from '../utils/reservation-scope.js';
import {
  nowInBuenosAires,
  describeScheduledAtUtcCompact,
} from '../utils/reservation-datetime.js';
import * as templates from '../utils/message-templates.js';
import { formatName } from '../utils/formatters.js';

/** How long (ms) to wait for more messages before processing the batch. */
const DEBOUNCE_MS = 1500;
const DUPLICATE_OUTBOUND_WINDOW_MS = 10000;
const INACTIVE_FALLBACK_TTL_SECONDS = 120;

export class WhatsAppHandler {
  private baileysService: BaileysService;
  private lastSentByChat: Map<string, { text: string; timestamp: number }> = new Map();

  /**
   * Debounce buffer: accumulates rapid messages per conversation.
   * When the timer fires the whole batch is merged into one text and processed once.
   */
  private debounceBuffer: Map<
    string,
    { messages: BaileysMessage[]; timer: ReturnType<typeof setTimeout> }
  > = new Map();

  /**
   * Per-conversation processing lock.
   * Ensures that if a new batch arrives while the previous one is still being
   * processed (e.g. slow AI), the new batch waits instead of running in parallel.
   */
  private processingLock: Map<string, Promise<void>> = new Map();

  /**
   * Pending messages that arrived while a conversation was being processed.
   * After the current processing finishes, these are merged and re-processed
   * so the bot always responds to the full context.
   */
  private pendingWhileProcessing: Map<string, BaileysMessage[]> = new Map();

  constructor(baileysService: BaileysService) {
    this.baileysService = baileysService;
  }

  /**
   * Debounce incoming messages per conversation.
   * Multiple messages arriving within DEBOUNCE_MS are merged into a single call
   * to _processMessage, producing exactly one response.
   *
   * If a previous batch is still being processed (LLM latency), incoming
   * messages are coalesced into a pending buffer. When the in-flight processing
   * finishes, the pending buffer is drained and merged into a single call,
   * ensuring the bot always responds to the latest user context.
   */
  async processMessage(message: BaileysMessage): Promise<void> {
    const { from, businessId } = message;
    const phone = this.normalizeWhatsAppNumber(from);
    const conversationId = `${businessId}-${phone}`;

    // If there is active processing for this conversation (LLM in-flight),
    // accumulate the message for processing after the current one finishes.
    if (this.processingLock.has(conversationId)) {
      const pending = this.pendingWhileProcessing.get(conversationId) ?? [];
      pending.push(message);
      this.pendingWhileProcessing.set(conversationId, pending);
      logger.debug('Message queued while processing in-flight', {
        conversationId,
        pendingCount: pending.length,
        text: message.message.substring(0, 80),
      });
      return;
    }

    const existing = this.debounceBuffer.get(conversationId);
    if (existing) {
      // More messages were received before the timer fired; accumulate and reset timer
      clearTimeout(existing.timer);
      existing.messages.push(message);
    }

    const entry = existing ?? { messages: [message], timer: undefined as any };

    const timer = setTimeout(() => {
      this.debounceBuffer.delete(conversationId);
      this.dispatchBatch(conversationId, entry.messages);
    }, DEBOUNCE_MS);

    entry.timer = timer;
    if (!existing) {
      this.debounceBuffer.set(conversationId, entry);
    }
  }

  /**
   * Merge a batch of messages and process them, then drain any pending messages
   * that arrived during processing.
   */
  private dispatchBatch(conversationId: string, batch: BaileysMessage[]): void {
    // Deduplicate consecutive identical messages before joining (e.g. user tapping "Si" twice fast
    // would otherwise merge to "Si\nSi" → normalized "si si" → no opt-in pattern match → loop).
    const deduplicatedTexts = batch
      .map(m => m.message)
      .filter((msg, idx, arr) => idx === 0 || msg.trim() !== arr[idx - 1].trim());

    const combined: BaileysMessage = {
      ...batch[0],
      message: deduplicatedTexts.join('\n'),
    };

    if (batch.length > 1) {
      logger.debug('Batching rapid messages into one', {
        conversationId,
        count: batch.length,
        combined: combined.message.substring(0, 120),
      });
    }

    // Serialize against any in-progress processing for this conversation
    const previous = this.processingLock.get(conversationId) ?? Promise.resolve();
    const current = previous
      .then(() => this.runTurn(conversationId, combined))
      .catch(error => { logger.error('Error in _processMessage', { conversationId, error }); })
      .finally(() => {
        // Remove the lock BEFORE draining pending so the next batch can re-acquire it.
        if (this.processingLock.get(conversationId) === current) {
          this.processingLock.delete(conversationId);
        }

        // Drain any messages that accumulated while we were processing.
        const pending = this.pendingWhileProcessing.get(conversationId);
        if (pending && pending.length > 0) {
          this.pendingWhileProcessing.delete(conversationId);
          logger.debug('Draining pending messages accumulated during processing', {
            conversationId,
            count: pending.length,
          });
          this.dispatchBatch(conversationId, pending);
        }
      });
    this.processingLock.set(conversationId, current);
  }

  /**
   * Envuelve un turno completo: abre el contexto de log (para que todo lo que
   * se emita adentro lleve `conversationId`/`businessId`/`phone` sin repetirlo
   * a mano) y cierra con una única línea `turn.completed`.
   *
   * Esa línea es el índice del sistema: con `grep '"event":"turn.completed"'`
   * se ve el estado de todas las conversaciones, y recién si algo se ve mal
   * hace falta bajar a `LOG_LEVEL=debug` a leer la traza.
   */
  private async runTurn(conversationId: string, message: BaileysMessage): Promise<void> {
    const startedAt = Date.now();
    const phone = this.normalizeWhatsAppNumber(message.from);

    await withLogContext(
      { businessId: message.businessId, phone, conversationId },
      () =>
        withTurnStats(async (stats) => {
          try {
            await this._processMessage(message);
          } finally {
            logEvent('info', 'turn.completed', {
              durationMs: Date.now() - startedAt,
              llmCalls: stats.llmCalls,
              llmMs: stats.llmMs,
              outbound: stats.outbound,
              language: currentLanguage(),
              ...(stats.step && { step: stats.step }),
              ...(stats.blocked && { blocked: stats.blocked }),
            });
          }
        })
    );
  }

  /**
   * Internal processor — receives one (possibly merged) message per invocation.
   *
   * Resolves the conversation language and runs the whole turn inside that
   * language context, so every `templates.*` call downstream emits in the
   * customer's language without any of the ~200 call sites knowing about it.
   *
   * Language resolution happens BEFORE the inactive-service check on purpose —
   * that fallback message is customer-facing too.
   */
  private async _processMessage(message: BaileysMessage): Promise<void> {
    // Hoisted so the catch below can still answer in the customer's language.
    // `runWithLanguage` is AsyncLocalStorage.run: the store is already gone by the
    // time a rejection resumes here, so the catch would otherwise fall back to
    // Spanish for an EN/PT customer. Re-entering the context explicitly fixes that.
    let resolvedLanguage: SupportedLanguage = DEFAULT_LANGUAGE;

    try {
      const { from, message: messageText, businessId, fromMe } = message;
      if (this.shouldIgnoreMessage(from, messageText, fromMe, businessId)) {
        return;
      }

      // Normalize WhatsApp JID to raw phone number (strip domain and device suffix)
      const phone = this.normalizeWhatsAppNumber(from);
      const conversationId = `${businessId}-${phone}`;

      // Cache the JID mapping in Redis for future outbound messages
      // This ensures we send to the correct JID (@lid vs @s.whatsapp.net)
      try {
        const client = RedisConfig.getClient();
        const jidMappingKey = `jid:${businessId}:${phone}`;
        await client.setEx(jidMappingKey, 30 * 24 * 60 * 60, from); // 30 days TTL
        logger.debug('JID mapping cached', { phone, from, businessId });
      } catch (error) {
        logger.debug('Failed to cache JID mapping', { error, phone, from });
      }

      logger.debug('Processing WhatsApp message', {
        businessId,
        phone,
        from,
        conversationId,
        messageLength: messageText.length,
      });

      // Check if business WhatsApp is active.
      // Only send inactive fallback when we can confirm inactive state from business data.
      const businessStatus = await SupabaseService.getBusinessById(businessId);
      if (!businessStatus) {
        logger.debug('Skipping inactive fallback due to unknown business state', {
          businessId,
          phone,
          conversationId,
        });
        return;
      }

      const { language } = await this.resolveConversationLanguage(
        businessId,
        phone,
        messageText,
        businessStatus.language
      );
      resolvedLanguage = language;

      await runWithLanguage(language, () =>
        this._processMessageWithAgent(message, businessStatus, phone, conversationId, language)
      );
    } catch (error) {
      // The try above wraps the whole turn, not just language resolution — the old
      // log label claimed otherwise and hid the real cause of every failure here.
      logger.error('Unhandled error processing WhatsApp message', {
        error,
        businessId: message.businessId,
        from: message.from,
      });

      // Never leave the customer in silence: they can't tell a crash from being
      // ignored. sendWhatsAppMessage swallows its own errors and dedupes identical
      // text within DUPLICATE_OUTBOUND_WINDOW_MS, so this can't throw or spam.
      await runWithLanguage(resolvedLanguage, () =>
        this.sendWhatsAppMessage(message.businessId, message.from, templates.genericError())
      );
    }
  }

  /**
   * Un solo cerebro con tool-calling: no hay pasos ni gates, el orquestador
   * recibe el mensaje y devuelve lo que haya que enviar. La única
   * responsabilidad que queda acá es entregar esos mensajes por WhatsApp,
   * con el mismo dedupe de salida que el resto del handler.
   */
  private async _processMessageWithAgent(
    message: BaileysMessage,
    businessStatus: Business,
    phone: string,
    conversationId: string,
    language: SupportedLanguage
  ): Promise<void> {
    const { from, message: messageText, businessId } = message;

    // Si el comercio desconectó WhatsApp, se avisa una vez y no se procesa nada.
    const isActive =
      businessStatus.whatsapp_session_id !== null && businessStatus.whatsapp_session_id !== undefined;
    if (!isActive) {
      if (await this.shouldSendInactiveFallback(businessId, phone)) {
        await this.sendWhatsAppMessage(businessId, from, templates.inactiveFallback());
      }
      return;
    }

    try {
      // Elegir idioma es previo al flujo, así que corre antes del orquestador,
      // sin crear ningún draft.
      //
      // Sólo en primer contacto REAL, es decir cuando no hay historial. Sin
      // este guard, un cliente que ya venía conversando recibía el menú de
      // idiomas en medio del flujo — al dar su nombre, por ejemplo, que no es
      // un saludo y no trae señal de idioma suficiente.
      const conversationStarted = (await loadHistory(conversationId)).length > 0;
      const onboardingStep = conversationStarted ? await loadOnboardingStep(conversationId) : null;

      const languageAction = conversationStarted
        ? 'none'
        : await this.resolveFirstContactLanguageAction(businessId, phone, messageText);

      if (languageAction === 'menu') {
        const menu = templates.languageWelcomeMenu(businessStatus.name || 'el local');
        await this.sendWhatsAppMessage(businessId, from, menu);

        // El menú se registra en el historial del agente para que, cuando el
        // cliente conteste "2" o mande una bandera, el modelo tenga a la vista
        // qué se le ofreció y pueda resolverlo con `set_language`. Sin esto la
        // respuesta llegaría sin contexto y parecería un mensaje suelto.
        await appendExchange(conversationId, messageText, menu);
        await setOnboardingStep(conversationId, 'language');

        logger.debug('Language menu offered on first contact', {
          conversationId,
          businessId,
        });
        return;
      }

      if (languageAction === 'hint') {
        await this.sendWhatsAppMessage(businessId, from, templates.languageChangeHint());
        // No hay `return`: el mensaje ya trae contenido real, así que el turno
        // sigue normalmente en el idioma inferido.
      }

      // Alta de un cliente nuevo: idioma → nombre → menú de apertura. Los tres
      // mensajes son fijos, así que los manda el handler y no el modelo.
      //
      // Ningún paso reintenta: si el cliente contesta otra cosa, se abandona el
      // alta y el turno sigue con el modelo. Insistir con "elegí una opción"
      // es justo lo que se sacó del flujo viejo.
      if (onboardingStep === 'language') {
        const choice = parseLanguageMenuChoice(messageText);
        if (choice) {
          await persistLanguage(businessId, phone, choice.language);

          // El turno se resolvió con el idioma anterior (se fijó antes de leer
          // este mensaje), así que la pregunta se renderiza con el catálogo
          // nuevo a mano en vez de esperar al turno siguiente.
          const askName = getTemplates(choice.language).onboardingAskName();
          await this.sendWhatsAppMessage(businessId, from, askName);
          await appendExchange(conversationId, messageText, askName);
          await setOnboardingStep(conversationId, 'name');

          logger.debug('Language chosen, asking for the name', {
            conversationId,
            businessId,
            language: choice.language,
          });
          return;
        }
        await clearOnboardingStep(conversationId);
      }

      if (onboardingStep === 'name') {
        await clearOnboardingStep(conversationId);
        const parsedName = this.parseOnboardingName(messageText);
        if (parsedName) {
          // Se crea la ficha ahora y no al reservar: el cliente ya dio su
          // nombre, y si se pierde acá el próximo "hola" vuelve a arrancar por
          // el menú de idiomas como si nunca hubiera escrito.
          await SupabaseService.getOrCreateCustomer(
            parsedName.name,
            phone,
            businessId,
            parsedName.lastName
          );

          const menu = await this.buildWelcomeMenu(businessId, businessStatus.name, parsedName.name);
          await this.sendWhatsAppMessage(businessId, from, menu);
          await appendExchange(conversationId, messageText, menu);

          logger.debug('Onboarding completed', { conversationId, businessId });
          return;
        }
      }

      // Saludo de apertura con las dos cosas que el asistente sabe hacer.
      //
      // Es determinista y no del modelo porque es la carta de presentación del
      // local: tiene que ser siempre igual. Sólo aplica a un "hola" pelado — si
      // el primer mensaje ya trae el pedido ("hoy 21:30 para 4"), mostrarle un
      // menú sería hacerle repetir lo que acaba de escribir.
      //
      // El menú no es un paso: se registra en el historial y ahí termina su
      // trabajo. Si el cliente contesta cualquier otra cosa en vez de 1 o 2, el
      // turno siguiente lo atiende el modelo como cualquier mensaje. No hay
      // reintentos ni "opción inválida" — para este menú no existe.
      if (!conversationStarted && this.isGreetingMessage(messageText)) {
        const customer = await SupabaseService.getCustomerByPhone(phone, businessId);
        // 'unknown' es el placeholder de las altas sin nombre real: saludar
        // "¡Hola, unknown!" es peor que no saludar por nombre.
        const knownName = customer?.name?.trim();
        const menu = await this.buildWelcomeMenu(
          businessId,
          businessStatus.name,
          knownName && knownName.toLowerCase() !== 'unknown' ? knownName : null
        );
        await this.sendWhatsAppMessage(businessId, from, menu);
        await appendExchange(conversationId, messageText, menu);

        logger.debug('Welcome menu sent on first contact', {
          conversationId,
          businessId,
        });
        return;
      }

      const result = await handleTurn({
        businessId,
        conversationId,
        phone,
        jid: from,
        messageText,
        language,
        businessName: businessStatus.name,
      });

      // Las imágenes van PRIMERO y el texto debajo: las fotos enganchan y el
      // detalle queda como el último mensaje visible, que es el que el
      // cliente tiene a mano para responder. Secuencial a propósito: Baileys
      // serializa los envíos y en paralelo las fotos llegan desordenadas.
      for (const attachment of result.attachments) {
        await this.sendWhatsAppImage(businessId, from, attachment.imageUrl, attachment.caption);
      }

      for (const text of result.messages) {
        await this.sendWhatsAppMessage(businessId, from, text);
      }

      logger.debug('Agent turn completed', {
        conversationId,
        businessId,
        tools: result.toolsCalled,
        iterations: result.iterations,
        outbound: result.messages.length,
        attachments: result.attachments.length,
      });
    } catch (error) {
      logger.error('Agent turn failed', { error, conversationId, businessId });
      await this.sendWhatsAppMessage(businessId, from, templates.genericError());
    }
  }

  /**
   * Menú de apertura con los eventos vigentes del local.
   *
   * Los eventos se listan acá y no los cuenta el modelo: es el primer mensaje
   * de la conversación y todavía no corrió ninguna herramienta, así que si no
   * van en el texto fijo el cliente no se entera de que existen.
   */
  private async buildWelcomeMenu(
    businessId: string,
    businessName: string | null | undefined,
    customerName: string | null
  ): Promise<string> {
    const events = await SupabaseService.getActiveEvents(businessId);
    const nowBA = nowInBuenosAires();

    return templates.welcomeMenu(
      businessName || 'el local',
      customerName,
      events.map((event) => ({
        title: event.title,
        whenLabel: describeScheduledAtUtcCompact(event.startsAt, nowBA),
      }))
    );
  }

  /**
   * El nombre con el que contesta un cliente nuevo: "Daniel", "soy Daniel",
   * "me llamo Daniel Pérez".
   *
   * Devuelve null ante cualquier duda — y entonces el turno lo atiende el
   * modelo. Guardar "quiero reservar para hoy" como nombre es mucho peor que
   * dejar pasar un nombre raro: el saludo por nombre queda roto para siempre.
   */
  private parseOnboardingName(text: string): { name: string; lastName: string | null } | null {
    const candidate = text
      .trim()
      .replace(/^hola[,!\s]+/i, '')
      .replace(/^(soy|me llamo|mi nombre es|my name is|i am|i'm|meu nome e|meu nome é|sou)\s+/i, '')
      .replace(/[.!¡¿?]+$/g, '')
      .trim();

    if (!candidate || !looksLikePersonName(candidate) || isObviouslyGibberish(candidate)) {
      return null;
    }

    const words = candidate.split(/\s+/);
    return {
      name: formatName(words[0]),
      lastName: words.length > 1 ? formatName(words.slice(1).join(' ')) : null,
    };
  }

  /**
   * Redis → customers.preferred_language → auto-detection → businesses.language.
   *
   * Auto-detection only runs when the customer never made an explicit choice,
   * and its result is cached but NOT written to the DB: it's our inference, not
   * their decision, so `preferred_language` stays NULL and the language menu is
   * still offered on first contact.
   */
  private async resolveConversationLanguage(
    businessId: string,
    phone: string,
    messageText: string,
    businessLanguage?: string | null
  ): Promise<{ language: SupportedLanguage }> {
    const resolved = await resolveLanguage(businessId, phone, businessLanguage);

    if (resolved.isExplicit) {
      logger.debug('Language resolved', {
        phone,
        businessId,
        language: resolved.language,
        source: resolved.source,
      });
      return { language: resolved.language };
    }

    const detected = detectLanguage(messageText);
    if (detected && detected.confidence >= DETECTION_THRESHOLD) {
      logger.debug('Language auto-detected', {
        phone,
        businessId,
        language: detected.language,
        confidence: detected.confidence,
        previous: resolved.language,
      });
      await cacheDetectedLanguage(businessId, phone, detected.language);
      return { language: detected.language };
    }

    logger.debug('Language resolved', {
      phone,
      businessId,
      language: resolved.language,
      source: resolved.source,
    });
    return { language: resolved.language };
  }

  /**
   * Decide QUÉ corresponde hacer con el idioma en un primer contacto, sin
   * ejecutar nada. Elegir idioma es previo al flujo de reserva, no parte de
   * él, y un turista que escribe por primera vez tiene que ver el menú.
   *
   * - `menu`: mostrar el menú de idiomas y esperar la elección.
   * - `hint`: el mensaje ya trae idioma inferible con confianza y contenido
   *   real, así que se sigue en ese idioma y sólo se avisa que puede cambiarlo.
   * - `none`: cliente ya conocido, no se interrumpe.
   */
  private async resolveFirstContactLanguageAction(
    businessId: string,
    phone: string,
    messageText: string
  ): Promise<'menu' | 'hint' | 'none'> {
    const knownCustomer = await SupabaseService.getCustomerByPhone(phone, businessId);
    if (knownCustomer?.name) {
      return 'none';
    }

    const detected = detectLanguage(messageText);
    const hasContentBeyondGreeting = !this.isGreetingMessage(messageText);
    if (detected && detected.confidence >= DETECTION_THRESHOLD && hasContentBeyondGreeting) {
      return 'hint';
    }

    return 'menu';
  }

  /**
   * Send message via WhatsApp
   */
  private async sendWhatsAppMessage(
    businessId: string,
    to: string,
    message: string
  ): Promise<void> {
    try {
      const dedupKey = `${businessId}:${to}`;
      const lastSent = this.lastSentByChat.get(dedupKey);
      if (
        lastSent &&
        lastSent.text === message &&
        Date.now() - lastSent.timestamp < DUPLICATE_OUTBOUND_WINDOW_MS
      ) {
        logger.debug('Suppressing duplicate outbound message', {
          businessId,
          to,
          windowMs: DUPLICATE_OUTBOUND_WINDOW_MS,
        });
        return;
      }

      const success = await this.baileysService.sendMessage(businessId, to, message);

      if (!success) {
        // `BaileysService.sendMessage` ya emitió `msg.out_failed` con la causa
        // tipificada; duplicarlo acá sólo agregaría ruido sin información.
        return;
      }

      recordOutbound();
      this.lastSentByChat.set(dedupKey, {
        text: message,
        timestamp: Date.now(),
      });
    } catch (error) {
      logger.error('Error sending WhatsApp message', { error, businessId, to });
    }
  }

  /**
   * Envía una imagen por WhatsApp. Hermano de sendWhatsAppMessage, pero sin
   * pasar por el dedupe de salientes: ese guard compara el texto del mensaje,
   * y dos fotos distintas del mismo evento tienen el mismo caption (o ninguno),
   * así que las descartaría por duplicadas.
   */
  private async sendWhatsAppImage(
    businessId: string,
    to: string,
    imageUrl: string,
    caption?: string
  ): Promise<void> {
    try {
      const success = await this.baileysService.sendImageMessage(businessId, to, imageUrl, caption);
      if (!success) {
        // BaileysService ya emitió msg.out_failed con la causa tipificada.
        return;
      }
      recordOutbound();
    } catch (error) {
      logger.error('Error sending WhatsApp image', { error, businessId, to, imageUrl });
    }
  }

  private async shouldSendInactiveFallback(businessId: string, phone: string): Promise<boolean> {
    try {
      if (!RedisConfig.isReady()) {
        logger.debug('Redis not ready, skipping inactive fallback send to avoid false positives', {
          businessId,
          phone,
        });
        return false;
      }

      const client = RedisConfig.getClient();
      const key = `wa:fallback:inactive:${businessId}:${phone}`;
      const wasSet = await client.set(key, '1', {
        NX: true,
        EX: INACTIVE_FALLBACK_TTL_SECONDS,
      });

      return !!wasSet;
    } catch (error) {
      logger.error('Error applying inactive fallback throttle, skipping fallback send', {
        businessId,
        phone,
        error,
      });
      return false;
    }
  }

  private shouldIgnoreMessage(
    from: string,
    _messageText: string,
    fromMe: boolean | undefined,
    businessId: string
  ): boolean {
    const isTestEnv = process.env.NODE_ENV === 'test';

    if (isTestEnv) {
      // In test we allow self-chat messages, but outbound bot echoes are filtered in BaileysService.
      logger.debug('TEST MODE: processing inbound message', { businessId, from, fromMe });
      return false;
    } else {
      // En producción: ignorar todos los mensajes fromMe (respuestas del bot)
      if (fromMe) {
        logger.debug('Ignoring own message in production mode', { businessId, from });
        return true;
      }
      return false;
    }
  }

  private normalizeWhatsAppNumber(jid: string): string {
    return normalizePhone(jid);
  }

  private normalizeCourtesyText(text: string): string {
    return text
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[¡!¿?.,;:]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private isGreetingMessage(text: string): boolean {
    // Multilingual by union (ES/EN/PT) — see src/i18n/keywords.ts. A tourist
    // greets in their own language before ever seeing the language menu, so
    // this matcher must recognise "hi" and "oi" as readily as "hola".
    return isMultilingualGreeting(this.normalizeCourtesyText(text));
  }
}
