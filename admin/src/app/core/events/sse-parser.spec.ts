import { createSseParser } from './sse-parser';

describe('createSseParser', () => {
  it('parses a complete frame with an event name and data', () => {
    const parser = createSseParser();
    expect(parser.push('event: done\ndata: {"id":1}\n\n')).toEqual([
      { event: 'done', data: '{"id":1}' },
    ]);
  });

  it('ignores comment lines such as heartbeats', () => {
    const parser = createSseParser();
    expect(parser.push(': connected\n\n: ping\n\n')).toEqual([]);
  });

  it('keeps partial frames until they are complete, across chunks', () => {
    const parser = createSseParser();
    expect(parser.push('event: needs_appr')).toEqual([]);
    expect(parser.push('oval\ndata: {"id"')).toEqual([]);
    expect(parser.push(':2}\n')).toEqual([]);
    expect(parser.push('\n')).toEqual([{ event: 'needs_approval', data: '{"id":2}' }]);
  });

  it('handles CRLF line endings and several frames in one chunk', () => {
    const parser = createSseParser();
    expect(parser.push('event: done\r\ndata: a\r\n\r\nevent: failed\r\ndata: b\r\n\r\n')).toEqual([
      { event: 'done', data: 'a' },
      { event: 'failed', data: 'b' },
    ]);
  });

  it('joins multi-line data with newlines and defaults the event name to "message"', () => {
    const parser = createSseParser();
    expect(parser.push('data: line 1\ndata: line 2\n\n')).toEqual([
      { event: 'message', data: 'line 1\nline 2' },
    ]);
  });

  it('strips only one leading space after the colon and accepts fields without a space', () => {
    const parser = createSseParser();
    expect(parser.push('event:done\ndata:  two spaces\n\n')).toEqual([
      { event: 'done', data: ' two spaces' },
    ]);
  });

  it('drops frames without data and ignores unknown fields', () => {
    const parser = createSseParser();
    expect(parser.push('event: done\n\nid: 7\nretry: 100\ndata: x\n\n')).toEqual([
      { event: 'message', data: 'x' },
    ]);
  });

  it('starts clean after reset', () => {
    const parser = createSseParser();
    parser.push('event: done\ndata: half');
    parser.reset();
    expect(parser.push('data: fresh\n\n')).toEqual([{ event: 'message', data: 'fresh' }]);
  });
});
