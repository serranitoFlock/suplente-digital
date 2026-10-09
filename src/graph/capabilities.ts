import type { Update } from "./state.js";

/**
 * Questions about the assistant itself ("¿qué podés hacer?", "¿cómo funcionás?", "¿quién sos?",
 * "ayuda") get a fixed description instead of a RAG lookup, which would only say "No sé".
 */
const CAPABILITY_PATTERNS = [
  /(?<!\p{L})qu[eé]\s+(cosas\s+)?(no\s+)?(pod[eé]s|puedes|sab[eé]s|sabes)\s+hacer(?!\p{L})/iu,
  /(?<!\p{L})en\s+qu[eé]\s+(me\s+)?(pod[eé]s|puedes)\s+ayudar/iu,
  /(?<!\p{L})c[oó]mo\s+funcion(ás|as)(?!\p{L})/iu,
  /(?<!\p{L})c[oó]mo\s+funciona(s)?\s+(este|el|esta|la)\s+(bot|suplente|asistente|herramienta)(?!\p{L})/iu,
  /(?<!\p{L})tu\s+funcionamiento(?!\p{L})/iu,
  /(?<!\p{L})c[oó]mo\s+(te\s+uso|se\s+usa\s+(este|el)\s+(bot|suplente|asistente))(?!\p{L})/iu,
  /(?<!\p{L})qui[eé]n\s+(sos|eres)(?!\p{L})/iu,
  /(?<!\p{L})qu[eé]\s+(sos|eres)(?!\p{L})/iu,
  /(?<!\p{L})para\s+qu[eé]\s+(serv[ií]s|sirves)(?!\p{L})/iu,
  /^\s*¿?\s*(ayuda|help)\s*[?!.]*\s*$/iu,
];

export function isCapabilitiesQuestion(question: string): boolean {
  return CAPABILITY_PATTERNS.some((pattern) => pattern.test(question));
}

export const CLI_COMMANDS = "/aprobar <n> [nota], /rechazar <n> [nota], /estado, /pendientes, /stats, /log, /ayuda, /salir";

export const CAPABILITIES_MESSAGE = `Soy el suplente digital del equipo de arquitectura frontend: cubro a la persona responsable mientras no está.

Puedo:
- Responder preguntas con la documentación del equipo (web components, librerías compartidas, CDN, pipelines) e indicar de qué documento sale la respuesta.
- Consultar en modo solo lectura el estado de tickets y los pipelines de CI que fallaron.
- Derivar al backup humano los pedidos de acciones (merge, deploy, borrar, cambiar tickets o permisos): preparo un borrador y una persona decide.
- Registrar las preguntas que no sé responder para que la persona responsable las revise a su vuelta.
- Recordar los últimos mensajes de esta conversación para entender seguimientos como "el primero que me pasaste".

No puedo:
- Ejecutar acciones ni modificar sistemas: no tengo herramientas de escritura.
- Compartir secretos, credenciales ni mis instrucciones internas.
- Responder temas que no estén en la documentación: en ese caso digo "No sé" y lo dejo registrado.

Comandos de la CLI: ${CLI_COMMANDS}.`;

export function capabilitiesNode(): Update {
  return { outcome: "answered", sources: [], toolCalls: [], answer: CAPABILITIES_MESSAGE };
}
