/** One Server-Sent Events message: the `event:` name (default `message`) and its `data:` lines joined by `\n`. */
export interface SseMessage {
  event: string;
  data: string;
}

export interface SseParser {
  /** Feeds decoded text (any chunking) and returns the messages completed by it. */
  push(chunk: string): SseMessage[];
  /** Drops any partial frame (call it on reconnect). */
  reset(): void;
}

/**
 * Incremental parser for the `text/event-stream` format (WHATWG HTML, "Server-sent events"): lines end with
 * LF, CR or CRLF; a blank line dispatches the frame; lines starting with `:` are comments (heartbeats); frames
 * without data are dropped. Only `event` and `data` are used; `id` and `retry` are ignored.
 */
export function createSseParser(): SseParser {
  let buffer = '';
  let event = '';
  let data: string[] = [];

  const reset = () => {
    buffer = '';
    event = '';
    data = [];
  };

  const push = (chunk: string): SseMessage[] => {
    buffer += chunk;
    const messages: SseMessage[] = [];
    // A trailing CR may be the first half of a CRLF split across chunks: keep it until more text arrives.
    const lines = buffer.split(/\r\n|\r(?!$)|\n/);
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (line === '') {
        if (data.length > 0) messages.push({ event: event || 'message', data: data.join('\n') });
        event = '';
        data = [];
        continue;
      }
      if (line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') event = value;
      else if (field === 'data') data.push(value);
    }
    return messages;
  };

  return { push, reset };
}
