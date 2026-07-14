import { EventEmitter, once } from 'node:events';
import { get, request as nodeRequest, type ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import { createNodeHandler, listen } from '../src/index.js';
import { writeNodeResponse } from '../src/response.js';

async function withServer(
  app: { fetch(request: Request): Promise<Response> },
  run: (origin: string) => Promise<void>,
): Promise<void> {
  const server = await listen(app);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP address');
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('Node adapter', () => {
  it('should preserve method URL headers and streaming body', async () => {
    await withServer({
      async fetch(request) {
        const body = await request.text();
        return new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(`${request.method}:${new URL(request.url).pathname}:`));
            controller.enqueue(new TextEncoder().encode(`${request.headers.get('x-test')}:${body}`));
            controller.close();
          },
        }));
      },
    }, async (origin) => {
      const response = await fetch(`${origin}/items?view=all`, {
        method: 'POST',
        headers: { 'x-test': 'yes' },
        body: 'payload',
      });
      expect(await response.text()).toBe('POST:/items:yes:payload');
    });
  });

  it('should preserve DELETE request bodies', async () => {
    await withServer({
      async fetch(request) {
        return new Response(`${request.method}:${await request.text()}`);
      },
    }, async (origin) => {
      const response = await fetch(`${origin}/items/1`, { method: 'DELETE', body: 'reason' });
      expect(await response.text()).toBe('DELETE:reason');
    });
  });

  it('should abort the Web Request when the Node request closes', async () => {
    let observed!: () => void;
    let markStarted!: () => void;
    const aborted = new Promise<void>((resolve) => { observed = resolve; });
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const server = await listen({
      async fetch(request) {
        request.signal.addEventListener('abort', observed, { once: true });
        markStarted();
        await aborted;
        return new Response(null);
      },
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP address');
    const request = nodeRequest({ host: '127.0.0.1', port: address.port, path: '/' });
    request.once('error', () => undefined);
    request.end();
    await started;
    request.destroy();
    await aborted;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('should preserve repeated Set-Cookie headers', async () => {
    await withServer({
      async fetch() {
        const headers = new Headers();
        headers.append('set-cookie', 'one=1; Path=/');
        headers.append('set-cookie', 'two=2; Path=/');
        return new Response(null, { headers });
      },
    }, async (origin) => {
      const response = await fetch(origin);
      expect(response.headers.getSetCookie()).toEqual(['one=1; Path=/', 'two=2; Path=/']);
    });
  });

  it('should preserve response status text', async () => {
    await withServer({
      async fetch() {
        return new Response(null, { status: 418, statusText: 'Teapot Time' });
      },
    }, async (origin) => {
      const status = await new Promise<string | undefined>((resolve, reject) => {
        get(origin, (response) => {
          resolve(response.statusMessage);
          response.resume();
        }).once('error', reject);
      });
      expect(status).toBe('Teapot Time');
    });
  });

  it('should honor response backpressure', async () => {
    class FakeResponse extends EventEmitter {
      statusCode = 0;
      statusMessage = '';
      chunks: string[] = [];
      ended = false;
      setHeader() {}
      write(chunk: Buffer) {
        this.chunks.push(chunk.toString());
        if (this.chunks.length === 1) {
          setTimeout(() => this.emit('drain'), 0);
          return false;
        }
        return true;
      }
      end() { this.ended = true; }
      destroy(error?: Error) { if (error) this.emit('error', error); }
    }
    const target = new FakeResponse();
    const response = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('one'));
        controller.enqueue(new TextEncoder().encode('two'));
        controller.close();
      },
    }));
    await writeNodeResponse(response, target as unknown as ServerResponse, 'GET');
    expect(target.chunks).toEqual(['one', 'two']);
    expect(target.ended).toBe(true);
  });

  it('should omit a body for HEAD', async () => {
    await withServer({ fetch: async () => new Response('body', { headers: { etag: 'v1' } }) }, async (origin) => {
      const response = await fetch(origin, { method: 'HEAD' });
      expect(response.headers.get('etag')).toBe('v1');
      expect(await response.text()).toBe('');
    });
  });

  it('should call Connect next given an adapter failure', async () => {
    let nextError: unknown;
    const handler = createNodeHandler({ fetch: async () => { throw new Error('boom'); } });
    const { createServer } = await import('node:http');
    const server = createServer((request, response) => handler(request, response, (error) => {
      nextError = error;
      response.statusCode = 502;
      response.end('next');
    }));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP address');
    expect((await fetch(`http://127.0.0.1:${address.port}`)).status).toBe(502);
    expect(nextError).toMatchObject({ message: 'boom' });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('should return a minimal 500 when no next callback exists', async () => {
    await withServer({ fetch: async () => { throw new Error('boom'); } }, async (origin) => {
      const response = await fetch(origin);
      expect(response.status).toBe(500);
      expect(await response.text()).toBe('Internal Server Error');
    });
  });

  it('should close the server when the listen signal aborts', async () => {
    const controller = new AbortController();
    const server = await listen({ fetch: async () => new Response(null) }, { signal: controller.signal });
    const closed = once(server, 'close');
    controller.abort();
    await closed;
    expect(server.listening).toBe(false);
  });
});
