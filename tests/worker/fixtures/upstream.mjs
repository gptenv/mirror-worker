// Native workerd upstream fixture. Its stream cancellation must be observed
// inside the runtime, without a second idle HTTP hop to the Node test process.
let armed = false;
let active;

export default {
  async fetch(request, env) {
    const pathname = new URL(request.url).pathname;
    if (pathname === '/__fixture/arm') {
      armed = true;
      active = { cancelled: false, signalAborted: false };
      return new Response('armed');
    }
    if (pathname === '/__fixture/status') {
      return Response.json({ cancelled: active?.cancelled ?? false, signalAborted: active?.signalAborted ?? false });
    }
    if (pathname === '/__fixture/cleanup') {
      armed = false;
      if (active) active.finishRequested = true;
      return new Response('closed');
    }
    if (armed && pathname.endsWith('/f/conversation')) {
      armed = false;
      const state = active;
      const body = await request.json();
      request.signal.addEventListener('abort', () => { state.signalAborted = true; }, { once: true });
      const frame = { p: '', o: 'add', v: {
        conversation_id: body.conversation_id,
        message: {
          id: 'fixture-unfinished-node', author: { role: 'assistant' },
          content: { content_type: 'text', parts: ['fixture-partial-answer\n'] }, status: 'in_progress',
        },
      } };
      let timer;
      const expires = Date.now() + 20_000;
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(frame)}\n\n`));
          // Keep the request context alive without emitting upstream bytes.
          // Otherwise workerd correctly rejects a stream that can never make
          // progress, which is unrelated to downstream client cancellation.
          timer = setInterval(() => {
            if (state.finishRequested || Date.now() >= expires) {
              clearInterval(timer);
              controller.close();
            }
          }, 50);
        },
        cancel() { state.cancelled = true; clearInterval(timer); },
      }), { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store, no-transform' } });
    }
    return env.BACKEND.fetch(request);
  },
};
