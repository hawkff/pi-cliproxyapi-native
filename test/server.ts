import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { TestContext } from "node:test";

// Starts a loopback HTTP server that closes with the test, and returns its base URL.
export async function server(t: TestContext, handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const instance = createServer(handler);
  instance.listen(0, "127.0.0.1");
  await once(instance, "listening");
  t.after(async () => {
    const closed = once(instance, "close");
    instance.close();
    instance.closeAllConnections();
    await closed;
  });
  const address = instance.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}
