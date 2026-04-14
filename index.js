const path = require("node:path");
const fs = require("node:fs");
const http = require("node:http");
const { randomUUID, createHmac, timingSafeEqual } = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const express = require("express");
const { WebSocketServer } = require("ws");

loadDotEnv();

const PORT = Number(process.env.PORT) || 5173;
const isProd = process.argv.includes("--prod") || process.env.NODE_ENV === "production";
const DATA_DIR = path.resolve(__dirname, "data");
const ROOMS_DB_FILE = path.join(DATA_DIR, "rooms.db");
const APP_PASSWORD = process.env.APP_PASSWORD || "";
const AUTH_SECRET = process.env.AUTH_SECRET || APP_PASSWORD;
const AUTH_COOKIE_NAME = "excalidraw_auth";
const AUTH_COOKIE_TTL_SECONDS = 60 * 60 * 24 * 7;

if (!APP_PASSWORD) {
	console.error("Missing APP_PASSWORD in .env");
	process.exit(1);
}

const app = express();
const server = http.createServer(app);
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

const rooms = new Map();
let roomsLoadPromise = null;
let db = null;
const persistTimersByRoomId = new Map();
const ROOM_PERSIST_DEBOUNCE_MS = 180;

function loadDotEnv() {
	const envPath = path.resolve(__dirname, ".env");
	let rawEnv;

	try {
		rawEnv = fs.readFileSync(envPath, "utf-8");
	} catch {
		return;
	}

	for (const line of rawEnv.split(/\r?\n/)) {
		const trimmedLine = line.trim();
		if (!trimmedLine || trimmedLine.startsWith("#")) {
			continue;
		}

		const equalsIndex = trimmedLine.indexOf("=");
		if (equalsIndex === -1) {
			continue;
		}

		const key = trimmedLine.slice(0, equalsIndex).trim();
		let value = trimmedLine.slice(equalsIndex + 1).trim();

		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1);
		}

		if (!process.env[key]) {
			process.env[key] = value;
		}
	}
}

function parseCookies(cookieHeader = "") {
	return cookieHeader.split(";").reduce((accumulator, part) => {
		const separatorIndex = part.indexOf("=");
		if (separatorIndex === -1) {
			return accumulator;
		}

		const key = part.slice(0, separatorIndex).trim();
		const value = decodeURIComponent(part.slice(separatorIndex + 1).trim());
		accumulator[key] = value;
		return accumulator;
	}, {});
}

function getRequestProtocol(req) {
	return req.headers["x-forwarded-proto"] === "https" || req.secure ? "https" : "http";
}

function escapeHtml(value) {
	return String(value)
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

function createAuthToken() {
	const expiresAt = Date.now() + AUTH_COOKIE_TTL_SECONDS * 1000;
	const signature = createHmac("sha256", AUTH_SECRET).update(String(expiresAt)).digest("hex");
	return `${expiresAt}.${signature}`;
}

function isValidAuthToken(token) {
	if (!token || typeof token !== "string") {
		return false;
	}

	const parts = token.split(".");
	if (parts.length !== 2) {
		return false;
	}

	const [expiresAtValue, signature] = parts;
	const expiresAt = Number(expiresAtValue);
	if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) {
		return false;
	}

	const expectedSignature = createHmac("sha256", AUTH_SECRET).update(String(expiresAt)).digest("hex");
	const expectedBuffer = Buffer.from(expectedSignature);
	const actualBuffer = Buffer.from(signature);

	if (expectedBuffer.length !== actualBuffer.length) {
		return false;
	}

	return timingSafeEqual(expectedBuffer, actualBuffer);
}

function isAuthenticatedRequest(req) {
	const cookies = parseCookies(req.headers.cookie || "");
	return isValidAuthToken(cookies[AUTH_COOKIE_NAME]);
}

function buildCookieHeader(req, value, maxAgeSeconds = AUTH_COOKIE_TTL_SECONDS) {
	const parts = [`${AUTH_COOKIE_NAME}=${encodeURIComponent(value)}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${maxAgeSeconds}`];
	if (getRequestProtocol(req) === "https") {
		parts.push("Secure");
	}
	return parts.join("; ");
}

function sendAuthCookie(res, req, value) {
	res.setHeader("Set-Cookie", buildCookieHeader(req, value));
}

function clearAuthCookie(res, req) {
	res.setHeader("Set-Cookie", buildCookieHeader(req, "", 0));
}

function renderLoginPage(errorMessage = "") {
	const errorMarkup = errorMessage
		? `<p class="error">${escapeHtml(errorMessage)}</p>`
		: "";

	return `<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Excalidraw - Login</title>
    <style>
      :root { color-scheme: light; }
      * { box-sizing: border-box; }
      html, body { height: 100%; }
      body {
        margin: 0;
        font-family: Segoe UI, Tahoma, Geneva, Verdana, sans-serif;
        background: linear-gradient(180deg, #eef2f7 0%, #e7ecf4 100%);
        color: #1c2533;
        display: grid;
        place-items: center;
        padding: 24px;
      }
      .card {
        width: min(100%, 420px);
        background: rgba(255, 255, 255, 0.92);
        border: 1px solid #d9e0ec;
        border-radius: 16px;
        padding: 24px;
        box-shadow: 0 18px 42px rgba(31, 43, 61, 0.12);
      }
      h1 { margin: 0 0 8px; font-size: 1.35rem; }
      p { margin: 0 0 16px; color: #5f6f82; line-height: 1.5; }
      label { display: block; font-weight: 600; margin-bottom: 8px; }
      input {
        width: 100%;
        border: 1px solid #cfd8e6;
        border-radius: 10px;
        padding: 12px 14px;
        font-size: 1rem;
        margin-bottom: 12px;
      }
      button {
        width: 100%;
        border: 0;
        border-radius: 10px;
        padding: 12px 14px;
        font-size: 1rem;
        font-weight: 700;
        color: white;
        background: #243b53;
        cursor: pointer;
      }
      button:hover { background: #1b2f43; }
      .error {
        color: #a64646;
        background: #fff4f4;
        border: 1px solid #efcaca;
        border-radius: 10px;
        padding: 10px 12px;
        margin-bottom: 12px;
      }
      .hint { margin-top: 12px; font-size: 0.85rem; color: #66758a; }
    </style>
  </head>
  <body>
    <main class="card">
      <h1>Acesso restrito</h1>
      <p>Digite a senha definida no arquivo <strong>.env</strong> para abrir a area de colaboracao.</p>
      ${errorMarkup}
      <form method="post" action="/api/login">
        <label for="password">Senha</label>
        <input id="password" name="password" type="password" autocomplete="current-password" autofocus required />
        <button type="submit">Entrar</button>
      </form>
      <div class="hint">A senha nao fica embutida no bundle do navegador; ela e verificada apenas no servidor.</div>
    </main>
  </body>
</html>`;
}

function authGate(req, res, next) {
	if (req.path === "/api/login" || req.path === "/api/logout") {
		next();
		return;
	}

	if (isAuthenticatedRequest(req)) {
		next();
		return;
	}

	if (req.path.startsWith("/api/")) {
		res.status(401).json({ error: "Unauthorized" });
		return;
	}

	if (req.method === "GET" || req.method === "HEAD") {
		const errorMessage = req.query?.error ? "Senha invalida" : "";
		res.status(200).set({ "Content-Type": "text/html; charset=utf-8" }).end(renderLoginPage(errorMessage));
		return;
	}

	res.status(401).json({ error: "Unauthorized" });
}

function createRoomRecord(roomId) {
	return {
		id: roomId,
		clients: new Set(),
		scene: {
			elements: [],
			files: {}
		},
		sceneVersion: 0,
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString()
	};
}

function toSerializableRoom(room) {
	return {
		id: room.id,
		createdAt: room.createdAt,
		updatedAt: room.updatedAt,
		scene: room.scene,
		sceneVersion: room.sceneVersion
	};
}

function ensureRoom(roomId) {
	if (!rooms.has(roomId)) {
		rooms.set(roomId, createRoomRecord(roomId));
	}

	return rooms.get(roomId);
}

function initializeDatabase() {
	if (db) {
		return;
	}

	fs.mkdirSync(DATA_DIR, { recursive: true });
	db = new DatabaseSync(ROOMS_DB_FILE);
	db.exec(`
		CREATE TABLE IF NOT EXISTS rooms (
			id TEXT PRIMARY KEY,
			scene_json TEXT NOT NULL,
			scene_version INTEGER NOT NULL DEFAULT 0,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)
	`);
}

async function loadRoomsFromDatabase() {
	if (roomsLoadPromise) {
		return roomsLoadPromise;
	}

	roomsLoadPromise = (async () => {
		initializeDatabase();

		const rows = db
			.prepare("SELECT id, scene_json, scene_version, created_at, updated_at FROM rooms")
			.all();

		for (const row of rows) {
			let scene = { elements: [], files: {} };
			try {
				scene = JSON.parse(row.scene_json || "{}");
			} catch {
				scene = { elements: [], files: {} };
			}

			rooms.set(row.id, {
				id: row.id,
				clients: new Set(),
				scene: scene && typeof scene === "object" ? scene : { elements: [], files: {} },
				sceneVersion: Number(row.scene_version || 0),
				createdAt: row.created_at || new Date().toISOString(),
				updatedAt: row.updated_at || new Date().toISOString()
			});
		}
	})();

	return roomsLoadPromise;
}

function persistRoom(room) {
	if (!room || typeof room.id !== "string") {
		return;
	}

	initializeDatabase();

	db.prepare(
		`INSERT INTO rooms (id, scene_json, scene_version, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET
		 	scene_json = excluded.scene_json,
		 	scene_version = excluded.scene_version,
		 	updated_at = excluded.updated_at`
	).run(
		room.id,
		JSON.stringify(room.scene || { elements: [], files: {} }),
		Number(room.sceneVersion || 0),
		room.createdAt || new Date().toISOString(),
		room.updatedAt || new Date().toISOString()
	);
}

function schedulePersistRoom(room) {
	if (!room || typeof room.id !== "string") {
		return;
	}

	const existingTimer = persistTimersByRoomId.get(room.id);
	if (existingTimer) {
		clearTimeout(existingTimer);
	}

	const timer = setTimeout(() => {
		persistTimersByRoomId.delete(room.id);
		persistRoom(room);
	}, ROOM_PERSIST_DEBOUNCE_MS);

	persistTimersByRoomId.set(room.id, timer);
}

function deleteRoomFromDatabase(roomId) {
	initializeDatabase();
	db.prepare("DELETE FROM rooms WHERE id = ?").run(roomId);
}

function generateRoomId() {
	return randomUUID().slice(0, 8);
}

function removeClientFromRoom(roomId, ws) {
	const room = rooms.get(roomId);
	if (!room) {
		return;
	}

	room.clients.delete(ws);
}

function broadcastRoomListUpdate() {
	const payload = JSON.stringify({ type: "rooms-updated" });
	for (const room of rooms.values()) {
		for (const client of room.clients) {
			if (client.readyState === client.OPEN) {
				client.send(payload);
			}
		}
	}
}

function deleteRoom(roomId) {
	const room = rooms.get(roomId);
	if (!room) {
		return false;
	}

	for (const client of room.clients) {
		if (client.readyState === client.OPEN) {
			client.send(JSON.stringify({ type: "room-deleted", roomId }));
			client.close(4000, "room deleted");
		}
	}

	rooms.delete(roomId);
	const pendingTimer = persistTimersByRoomId.get(roomId);
	if (pendingTimer) {
		clearTimeout(pendingTimer);
		persistTimersByRoomId.delete(roomId);
	}
	deleteRoomFromDatabase(roomId);
	return true;
}

function listRooms() {
	return Array.from(rooms.values())
		.map(toSerializableRoom)
		.sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime());
}

function compareElementVersion(left, right) {
	const leftVersion = Number(left?.version || 0);
	const rightVersion = Number(right?.version || 0);

	if (leftVersion !== rightVersion) {
		return leftVersion - rightVersion;
	}

	const leftNonce = Number(left?.versionNonce || 0);
	const rightNonce = Number(right?.versionNonce || 0);
	if (leftNonce !== rightNonce) {
		return leftNonce - rightNonce;
	}

	const leftUpdated = Number(left?.updated || 0);
	const rightUpdated = Number(right?.updated || 0);
	if (leftUpdated !== rightUpdated) {
		return leftUpdated - rightUpdated;
	}

	return 0;
}

function mergeElements(existingElements = [], incomingElements = []) {
	const mergedById = new Map();

	for (const element of existingElements) {
		if (element && typeof element.id === "string") {
			mergedById.set(element.id, element);
		}
	}

	for (const element of incomingElements) {
		if (!element || typeof element.id !== "string") {
			continue;
		}

		const currentElement = mergedById.get(element.id);
		if (!currentElement || compareElementVersion(currentElement, element) <= 0) {
			mergedById.set(element.id, element);
		}
	}

	return Array.from(mergedById.values());
}

function mergeScene(existingScene, incomingScene) {
	const safeExistingScene = existingScene && typeof existingScene === "object" ? existingScene : { elements: [], files: {} };
	const safeIncomingScene = incomingScene && typeof incomingScene === "object" ? incomingScene : { elements: [], files: {} };

	const mergedElements = mergeElements(
		Array.isArray(safeExistingScene.elements) ? safeExistingScene.elements : [],
		Array.isArray(safeIncomingScene.elements) ? safeIncomingScene.elements : []
	);

	return {
		elements: mergedElements,
		files: {
			...(safeExistingScene.files && typeof safeExistingScene.files === "object" ? safeExistingScene.files : {}),
			...(safeIncomingScene.files && typeof safeIncomingScene.files === "object" ? safeIncomingScene.files : {})
		}
	};
}

function setupAuthRoutes() {
	app.post("/api/login", (req, res) => {
		const submittedPassword = typeof req.body?.password === "string" ? req.body.password : "";
		const expectedBuffer = Buffer.from(APP_PASSWORD);
		const submittedBuffer = Buffer.from(submittedPassword);

		const isPasswordValid =
			expectedBuffer.length === submittedBuffer.length &&
			timingSafeEqual(expectedBuffer, submittedBuffer);

		if (!isPasswordValid) {
			res.redirect(303, "/?error=1");
			return;
		}

		sendAuthCookie(res, req, createAuthToken());
		res.redirect(303, "/");
	});

	app.post("/api/logout", (req, res) => {
		clearAuthCookie(res, req);
		res.redirect(303, "/");
	});
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

function setupHttpApi() {
	app.get("/api/rooms", async (_req, res, next) => {
		try {
			await loadRoomsFromDatabase();
			res.json({ rooms: listRooms() });
		} catch (error) {
			next(error);
		}
	});

	app.put("/api/rooms/:roomId/scene", async (req, res, next) => {
		try {
			await loadRoomsFromDatabase();
			const roomId = String(req.params.roomId || "");
			const scene = req.body && typeof req.body.scene === "object" ? req.body.scene : null;

			if (!scene) {
				res.status(400).json({ error: "Invalid scene payload" });
				return;
			}

			const room = ensureRoom(roomId);
			room.scene = mergeScene(room.scene, scene);
			room.sceneVersion += 1;
			room.updatedAt = new Date().toISOString();
			persistRoom(room);
			broadcastRoomListUpdate();

			res.json({ room: toSerializableRoom(room) });
		} catch (error) {
			next(error);
		}
	});

	app.post("/api/rooms", async (req, res, next) => {
		try {
			await loadRoomsFromDatabase();
			const requestedRoomId = typeof req.body?.roomId === "string" ? req.body.roomId.trim() : "";
			const roomId = requestedRoomId || generateRoomId();
			const room = ensureRoom(roomId);
			room.updatedAt = new Date().toISOString();
			persistRoom(room);
			broadcastRoomListUpdate();
			res.status(201).json({ room: toSerializableRoom(room) });
		} catch (error) {
			next(error);
		}
	});

	app.delete("/api/rooms/:roomId", async (req, res, next) => {
		try {
			await loadRoomsFromDatabase();
			const roomId = String(req.params.roomId || "");
			const deleted = deleteRoom(roomId);
			if (!deleted) {
				res.status(404).json({ error: "Room not found" });
				return;
			}

			broadcastRoomListUpdate();
			res.status(204).end();
		} catch (error) {
			next(error);
		}
	});
}

function setupCollaboration() {
	const wss = new WebSocketServer({ server, path: "/ws" });

	wss.on("connection", (ws, req) => {
		if (!isAuthenticatedRequest(req)) {
			ws.close(4401, "unauthorized");
			return;
		}

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
				persistRoom(room);
				room.clients.add(ws);

				if (room.scene) {
					ws.send(
						JSON.stringify({
							type: "scene-sync",
							scene: room.scene,
							sceneVersion: room.sceneVersion,
							sourceClientId: "server"
						})
					);
				}

				return;
			}

			if (payload.type === "scene-update" && currentRoomId) {
				const room = ensureRoom(currentRoomId);
				room.scene = mergeScene(room.scene, payload.scene);
				room.sceneVersion += 1;
				room.updatedAt = new Date().toISOString();
				schedulePersistRoom(room);

				const broadcastData = JSON.stringify({
					type: "scene-sync",
					scene: room.scene,
					sceneVersion: room.sceneVersion,
					sourceClientId: payload.sourceClientId || "unknown"
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
	await loadRoomsFromDatabase();
	setupAuthRoutes();
	app.use(authGate);
	setupHttpApi();
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