import type { ServerResponse } from 'node:http';

function writeHeaders(response: Response, target: ServerResponse): void {
  const cookies = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [];
  response.headers.forEach((value, key) => {
    if (key !== 'set-cookie') target.setHeader(key, value);
  });
  if (cookies.length) target.setHeader('set-cookie', cookies);
}

function waitForDrain(response: ServerResponse): Promise<void> {
  return new Promise((resolve, reject) => {
    response.once('drain', resolve);
    response.once('error', reject);
  });
}

export async function writeNodeResponse(
  response: Response,
  target: ServerResponse,
  method?: string,
): Promise<void> {
  target.statusCode = response.status;
  target.statusMessage = response.statusText;
  writeHeaders(response, target);
  if (!response.body || method === 'HEAD') {
    target.end();
    return;
  }
  const reader = response.body.getReader();
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      if (!target.write(Buffer.from(part.value))) await waitForDrain(target);
    }
    target.end();
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    target.destroy(error instanceof Error ? error : undefined);
  }
}
