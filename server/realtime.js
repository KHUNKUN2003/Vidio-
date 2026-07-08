export function createRealtimeHub() {
  const clients = new Set();

  function send(response, eventName, data) {
    response.write(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  return {
    connect(request, response) {
      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });

      clients.add(response);
      send(response, "ready", { ok: true });

      request.on("close", () => {
        clients.delete(response);
        response.end();
      });
    },
    broadcast(type) {
      const payload = { type, at: new Date().toISOString() };
      for (const response of clients) {
        send(response, "message", payload);
      }
    },
    clientCount() {
      return clients.size;
    },
  };
}
