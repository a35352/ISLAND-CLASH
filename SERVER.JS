
const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const path = require("path");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({
  server,
  path: "/ws"
});

const players = new Map();
let nextId = 1;

app.use(express.static(path.join(__dirname, "public")));

function broadcast() {
  const message = JSON.stringify({
    type: "players",
    players: [...players.values()]
  });

  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  }
}

wss.on("connection", ws => {
  const id = String(nextId++);

  players.set(id, {
    id,
    x: 450,
    y: 400,
    name: "Pirate " + id
  });

  ws.send(JSON.stringify({ type: "welcome", id }));
  broadcast();

  ws.on("message", data => {
    try {
      const msg = JSON.parse(data.toString());

      if (msg.type === "move") {
        const player = players.get(id);
        if (!player) return;

        if (
          Number.isFinite(msg.x) &&
          Number.isFinite(msg.y)
        ) {
          player.x = Math.max(0, Math.min(1900, msg.x));
          player.y = Math.max(0, Math.min(1500, msg.y));
          broadcast();
        }
      }
    } catch (err) {
      console.error("Invalid message");
    }
  });

  ws.on("close", () => {
    players.delete(id);
    broadcast();
  });
});

const PORT = process.env.PORT || 10000;

server.listen(PORT, "0.0.0.0", () => {
  console.log("Island Clash running on port " + PORT);
});
