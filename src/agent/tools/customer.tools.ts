import { AgentTool, ToolResult, fail, ok } from './types.js';
import { SupabaseService } from '../../services/supabase.service.js';
import { coerceLanguage, LANGUAGE_ENGLISH_NAMES, SUPPORTED_LANGUAGES } from '../../i18n/index.js';
import { persistLanguage } from '../../i18n/language-store.js';
import * as templates from '../../utils/message-templates.js';
import { logger } from '../../utils/logger.js';

/**
 * Herramientas sobre el cliente que escribe.
 *
 * Nota sobre identidad: `customers` está keyed por `(business_id, phone)`, así
 * que un mismo teléfono es un cliente distinto en cada comercio. Quién es y en
 * qué idioma habla se resuelve ANTES del primer token y viaja en el estado del
 * system prompt (ver src/agent/state.ts) — no como tool call — para que el
 * saludo por nombre no cueste una iteración extra del loop.
 *
 * Estas herramientas son para ESCRIBIR ese perfil cuando cambia durante la
 * conversación.
 */

interface UpdateNameArgs {
  name?: string;
  lastName?: string;
}

export const updateCustomerNameTool: AgentTool<UpdateNameArgs> = {
  definition: {
    type: 'function',
    function: {
      name: 'update_customer_name',
      description:
        'Guarda o corrige el nombre y/o apellido del cliente en su ficha del local. ' +
        'Usala cuando se presenta por primera vez, cuando corrige cómo se llama ("me llamo Matías, no Mati"), ' +
        'o cuando agrega su apellido. No la uses para nombres de terceros mencionados de paso.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Nombre de pila.' },
          lastName: { type: 'string', description: 'Apellido, sólo si lo dio.' },
        },
        required: [],
        additionalProperties: false,
      },
    },
  },

  async run({ name, lastName }, ctx): Promise<ToolResult> {
    const updates: { name?: string; lastName?: string } = {};
    if (name?.trim()) updates.name = name.trim();
    if (lastName?.trim()) updates.lastName = lastName.trim();

    if (Object.keys(updates).length === 0) {
      return fail('nothing_to_update', 'No se indicó nombre ni apellido.');
    }

    const customer = await SupabaseService.updateCustomerNameByPhone(ctx.phone, ctx.businessId, updates);

    // Sin ficha previa no es un error: el cliente es nuevo y su nombre se
    // persiste al crear la reserva (`getOrCreateCustomer`). Se le confirma al
    // modelo que el dato quedó tomado para que siga la conversación igual.
    if (!customer) {
      logger.debug('update_customer_name: no existing customer row yet', {
        businessId: ctx.businessId,
        phone: ctx.phone,
      });
      return ok({ saved: false, pendingUntilReservation: true, ...updates });
    }

    return ok({ saved: true, name: customer.name, lastName: customer.lastName ?? null });
  },
};

interface SetLanguageArgs {
  language: string;
}

export const setLanguageTool: AgentTool<SetLanguageArgs> = {
  definition: {
    type: 'function',
    function: {
      name: 'set_language',
      description:
        `Cambia el idioma de la conversación. Valores: ${SUPPORTED_LANGUAGES.join(', ')}. ` +
        'Usala sólo cuando el cliente PIDE explícitamente hablar en otro idioma ("¿podés hablarme en inglés?"). ' +
        'Si simplemente escribe en otro idioma, respondele en ese idioma sin llamar a esta herramienta.',
      parameters: {
        type: 'object',
        properties: {
          language: {
            type: 'string',
            enum: [...SUPPORTED_LANGUAGES],
            description: 'Código del idioma destino.',
          },
        },
        required: ['language'],
        additionalProperties: false,
      },
    },
  },

  async run({ language }, ctx): Promise<ToolResult> {
    const target = coerceLanguage(language);
    if (!target) {
      return fail(
        'unsupported_language',
        `Ese idioma no está soportado. Los disponibles son: ${SUPPORTED_LANGUAGES.join(', ')}.`
      );
    }

    // persistLanguage escribe el cache de Redis y la preferencia en Supabase.
    await persistLanguage(ctx.businessId, ctx.phone, target);

    // El aviso de cambio sale del catálogo del idioma NUEVO, no del anterior.
    return ok(
      { language: target, languageName: LANGUAGE_ENGLISH_NAMES[target] },
      templates.languageChanged()
    );
  },
};
