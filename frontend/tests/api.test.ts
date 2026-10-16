import { describe, expect, it, vi } from 'vitest';
import { ApiError, streamEvents, streamText } from '../src/api';

function response(lines: string[]) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(line));
      controller.close();
    },
  }), { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } });
}

describe('NDJSON generation stream', () => {
  it('stops an idle stream promptly and finishes on done without waiting for transport closure', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const start = () => vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new ReadableStream<Uint8Array>({ start(value) { controller = value; } }))));
    start();
    const abort = new AbortController();
    const pending = streamEvents('/stream', {}, () => undefined, abort.signal);
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    abort.abort();
    await rejected;
    start();
    const completed = streamEvents('/stream', {}, () => undefined);
    controller.enqueue(new TextEncoder().encode('{"type":"done"}\n'));
    await completed;
  });
  it('delivers preview events while the response is still open and rejects truncated streams', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new ReadableStream<Uint8Array>({ start(value) { controller = value; } }))));
    const preview = vi.fn();
    const pending = streamEvents('/stream', {}, preview);
    controller.enqueue(new TextEncoder().encode('{"type":"preview","reply":"half"}\n'));
    await vi.waitFor(() => expect(preview).toHaveBeenCalledWith({ type: 'preview', reply: 'half' }));
    const rejected = expect(pending).rejects.toMatchObject({ code: 'incomplete_stream' });
    controller.close();
    await rejected;
  });
  it('delivers chunks and requires a done event', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response([
      '{"type":"chunk","text":"hello "}\n',
      '{"type":"chunk","text":"world"}\n{"type":"done"}\n',
    ])));
    let text = '';
    await streamText('/stream', {}, (chunk) => { text += chunk; });
    expect(text).toBe('hello world');
  });

  it('throws structured errors without appending them to content', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response([
      '{"type":"chunk","text":"partial"}\n',
      '{"type":"error","error":{"code":"provider_failed","message":"No quota"}}\n',
    ])));
    let text = '';
    await expect(streamText('/stream', {}, (chunk) => { text += chunk; })).rejects.toMatchObject<ApiError>({ code: 'provider_failed' });
    expect(text).toBe('partial');
    expect(text).not.toContain('No quota');
  });
});
