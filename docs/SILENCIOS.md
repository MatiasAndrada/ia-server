# Silencios del bot en los números compartidos

En cuatro locales el número de WhatsApp lo comparten el bot y una persona: **De La Fonte** (Simona), **Antigal** (Valentina), **SKY** (su equipo) y **La Misión** (el equipo del hotel). Un **silencio** es un chat en el que el bot no contesta nada porque la conversación es de la persona.

Los silencios se crean solos. Esta guía explica cuándo se crean, cuánto duran y cómo verlos, agregarlos o quitarlos a mano por CLI.

> En los demás comercios (número exclusivo del bot) no hay silencios. Para que el bot no conteste en todo un comercio se apaga el chat con IA desde el panel (`ai_chat_enabled`).

## Qué activa un silencio

| | De La Fonte | Antigal | SKY | La Misión |
|---|---|---|---|---|
| **El cliente elige hablar con la persona** | escribe *PERSONAL*, o nombra a la dueña o la encargada ("quiero hablar con la dueña", "Simona") | escribe *Valentina*, o le habla como "Vale" ("hola vale", "quiero hablar con vale") | escribe exactamente *SKY*, *consulta(s)* o *info* | escribe exactamente *CONSULTAS*, o *1* justo después del saludo |
| **La persona escribe en el chat desde el celular** (no cuenta el saludo automático de WhatsApp Business) | sí | sí | sí | sí |
| **El modelo detecta que el mensaje es para la persona** (un amigo, un proveedor, un empleado) | sí | sí | sí | sí |
| **Cuánto dura** | **para siempre** | 48 h | 48 h | 48 h |
| **Cómo vuelve el bot solo** | nunca | el cliente escribe una palabra de reserva (*Reservar*, *Cancelar*, "mesa"…) | igual que Antigal | igual que Antigal, más *LA MISIÓN* |

Cuando el silencio lo activa la persona escribiendo desde el celular, la salida es más estricta: el cliente tiene que escribir la palabra **sola** ("Reservar"), porque en una charla con la persona es normal que aparezca "mesa" en medio de una frase.

"Vale" sólo cuenta como el apodo de Valentina cuando viene después de un saludo, de un "gracias" o de un "con". "¿Cuánto vale?" o "vale, para 4" no silencian a nadie.

## Dónde se guardan

En `data/shared-number-handoffs.jsonl`, en el servidor. Es un archivo de líneas JSON al que sólo se le agregan líneas: el alta, la baja y el historial quedan.

- **No se borra ni se edita a mano.** Para cambiar algo, usá el CLI.
- Sobrevive a reinicios del proceso y de Redis.
- Está en `.gitignore`, así que un `git pull` no lo toca.
- Los silencios de Antigal, SKY y La Misión anteriores al 01/10/2026 pueden estar todavía sólo en Redis hasta que vencen. El CLI también los muestra, con la marca "(sólo en Redis)".

## Administrar por CLI

Se corre desde `/root/ia-server`. El primer argumento es el local (`delafonte`, `antigal`, `sky` o `lamision`); si se omite, es De La Fonte.

```bash
# Ver los chats silenciados
npx ts-node scripts/handoff-silences.ts delafonte list
npx ts-node scripts/handoff-silences.ts antigal list

# Silenciar un número a mano
npx ts-node scripts/handoff-silences.ts delafonte add "+54 9 3757 44-1049"   # De La Fonte: siempre permanente
npx ts-node scripts/handoff-silences.ts antigal add 5493757441049             # 48 h, como un traspaso
npx ts-node scripts/handoff-silences.ts antigal add 5493757441049 --horas 72
npx ts-node scripts/handoff-silences.ts antigal add 5493757441049 --permanente

# Devolverle un chat al bot
npx ts-node scripts/handoff-silences.ts delafonte remove 5493757441049
```

- **El teléfono** se acepta en cualquier formato: con o sin `+`, con espacios o guiones, con o sin el 9 de los móviles argentinos. `remove` también acepta el `conversationId` entero, como lo muestra `list`.
- **`add` registra las dos variantes del número** (con y sin el 9), así coincide con el chat cualquiera sea la forma en que WhatsApp lo identifique. Por eso `list` puede mostrar dos líneas para un mismo número.
- **Efecto inmediato:** el servidor en marcha lo toma en el siguiente mensaje de ese chat. No hace falta reiniciar.
- **En Antigal, SKY y La Misión**, un silencio agregado a mano, incluso con `--permanente`, se levanta si el cliente escribe una palabra de reserva. Es la salida que les enseña el saludo.

## Casos comunes

**"Un cliente dice que el bot no le contesta."** Buscalo con `list`. Si está silenciado y no corresponde, `remove`. Si no figura, el problema es otro: revisá que el chat con IA del local esté prendido y los logs (`msg.in`, `msg.dropped`, `turn.silenced`).

**"El dueño pide que el bot no le hable más a un número."** `add` con ese número. En De La Fonte queda para siempre.

**"El bot le habló a un amigo de la dueña."** Con la persona escribiendo desde el celular, el chat se silencia solo. Si el amigo escribió primero y nadie le contestó todavía, `add` con su número.
