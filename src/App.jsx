import { useEffect, useMemo, useRef, useState } from "react";
import { Excalidraw } from "@excalidraw/excalidraw";

function getOrCreateRoomId() {
  const url = new URL(window.location.href);
  const existing = url.searchParams.get("room");
  if (existing) {
    return existing;
  }

  const generated = Math.random().toString(36).slice(2, 10);
  url.searchParams.set("room", generated);
  window.history.replaceState({}, "", url);
  return generated;
}

export default function App() {
  const [roomId] = useState(() => getOrCreateRoomId());
  const [status, setStatus] = useState("connecting");
  const [copied, setCopied] = useState(false);

  const excalidrawApiRef = useRef(null);
  const socketRef = useRef(null);
  const skipNextBroadcastRef = useRef(false);

  const shareLink = useMemo(() => {
    const url = new URL(window.location.href);
    url.searchParams.set("room", roomId);
    return url.toString();
  }, [roomId]);

  useEffect(() => {
    const socketProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const socketUrl = `${socketProtocol}//${window.location.host}/ws`;

    const ws = new WebSocket(socketUrl);
    socketRef.current = ws;

    ws.addEventListener("open", () => {
      setStatus("connected");
      ws.send(JSON.stringify({ type: "join-room", roomId }));
    });

    ws.addEventListener("close", () => {
      setStatus("disconnected");
    });

    ws.addEventListener("error", () => {
      setStatus("disconnected");
    });

    ws.addEventListener("message", (event) => {
      let payload;
      try {
        payload = JSON.parse(event.data);
      } catch {
        return;
      }

      if (payload.type !== "scene-sync" || !payload.scene) {
        return;
      }

      if (!excalidrawApiRef.current) {
        return;
      }

      skipNextBroadcastRef.current = true;
      excalidrawApiRef.current.updateScene(payload.scene);
    });

    return () => {
      ws.close();
      socketRef.current = null;
    };
  }, [roomId]);

  async function copyRoomLink() {
    await navigator.clipboard.writeText(shareLink);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  function handleChange(elements, appState, files) {
    if (skipNextBroadcastRef.current) {
      skipNextBroadcastRef.current = false;
      return;
    }

    const ws = socketRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return;
    }

    ws.send(
      JSON.stringify({
        type: "scene-update",
        roomId,
        scene: { elements, appState, files }
      })
    );
  }

  return (
    <main className="app-shell">
      <header className="app-header">
        <div className="title-wrap">
          <span>Excalidraw</span>
          <small>Sala: {roomId}</small>
          <small>Status: {status}</small>
        </div>
        <button type="button" onClick={copyRoomLink} className="copy-btn">
          {copied ? "Link copiado" : "Copiar link da sala"}
        </button>
      </header>
      <section className="canvas-wrap">
        <Excalidraw
          excalidrawAPI={(api) => {
            excalidrawApiRef.current = api;
          }}
          onChange={handleChange}
        />
      </section>
    </main>
  );
}
