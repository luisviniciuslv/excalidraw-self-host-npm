const path = require("node:path");
const fs = require("node:fs");
const http = require("node:http");
const express = require("express");
const { WebSocketServer } = require("ws");

const PORT = Number(process.env.PORT) || 5173;
const isProd = process.argv.includes("--prod") || process.env.NODE_ENV === "production";

const app = express();
const server = http.createServer(app);

const rooms = new Map();

function ensureRoom(roomId) {
	if (!rooms.has(roomId)) {
		rooms.set(roomId, {
			clients: new Set(),
			scene: null
		});
	}

	return rooms.get(roomId);
}

function removeClientFromRoom(roomId, ws) {
	const room = rooms.get(roomId);
	if (!room) {
		return;
	}

	room.clients.delete(ws);
	if (room.clients.size === 0) {
		rooms.delete(roomId);
	}
}

async function setupFrontend() {
	if (!isProd) {
		const { createServer: createViteServer } = await import("vite");
		const vite = await createViteServer({
			server: {
				middlewareMode: true
			},
			appType: "spa"
		});

		app.use(vite.middlewares);

		app.use("*", async (req, res, next) => {
			try {
				const url = req.originalUrl;
				const templatePath = path.resolve(__dirname, "index.html");
				const template = await fs.promises.readFile(templatePath, "utf-8");
				const html = await vite.transformIndexHtml(url, template);

				res.status(200).set({ "Content-Type": "text/html" }).end(html);
			} catch (error) {
				vite.ssrFixStacktrace(error);
				next(error);
			}
		});
		return;
	}

	const distPath = path.resolve(__dirname, "dist");
	app.use(express.static(distPath));
	app.use("*", (req, res) => {
		res.sendFile(path.join(distPath, "index.html"));
	});
}

function setupCollaboration() {
	const wss = new WebSocketServer({ server, path: "/ws" });

	wss.on("connection", (ws) => {
		let currentRoomId = null;

		ws.on("message", (rawData) => {
			let payload;
			try {
				payload = JSON.parse(rawData.toString());
			} catch {
				return;
			}

			if (payload.type === "join-room") {
				const roomId = String(payload.roomId || "default");
				currentRoomId = roomId;
				const room = ensureRoom(roomId);
				room.clients.add(ws);

				if (room.scene) {
					ws.send(JSON.stringify({ type: "scene-sync", scene: room.scene }));
				}

				return;
			}

			if (payload.type === "scene-update" && currentRoomId) {
				const room = ensureRoom(currentRoomId);
				room.scene = payload.scene;

				const broadcastData = JSON.stringify({
					type: "scene-sync",
					scene: payload.scene
				});

				for (const client of room.clients) {
					if (client !== ws && client.readyState === client.OPEN) {
						client.send(broadcastData);
					}
				}
			}
		});

		ws.on("close", () => {
			if (currentRoomId) {
				removeClientFromRoom(currentRoomId, ws);
			}
		});
	});
}

async function start() {
	await setupFrontend();
	setupCollaboration();

	server.listen(PORT, () => {
		const mode = isProd ? "production" : "development";
		console.log(`[excalidraw-self-host] ${mode} server running at http://localhost:${PORT}`);
	});
}

start().catch((error) => {
	console.error("Failed to start server:", error);
	process.exit(1);
});