import { useEffect, useMemo, useRef, useState } from "react";
import { Excalidraw } from "@excalidraw/excalidraw";

function getRoomIdFromUrl() {
  const url = new URL(window.location.href);
  const existing = url.searchParams.get("room");
  if (existing) {
    return existing;
  }

  return "";
}

function syncRoomIdInUrl(roomId) {
  const url = new URL(window.location.href);
  if (roomId) {
    url.searchParams.set("room", roomId);
  } else {
    url.searchParams.delete("room");
  }
  window.history.replaceState({}, "", url);
}

async function fetchRooms() {
  const response = await fetch("/api/rooms");
  if (response.status === 401) {
    window.location.href = "/";
    throw new Error("Unauthorized");
  }
  if (!response.ok) {
    throw new Error("Nao foi possivel carregar salas");
  }

  return response.json();
}

async function createRoom(roomId) {
  const response = await fetch("/api/rooms", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(roomId ? { roomId } : {})
  });

  if (response.status === 401) {
    window.location.href = "/";
    throw new Error("Unauthorized");
  }

  if (!response.ok) {
    throw new Error("Nao foi possivel criar sala");
  }

  return response.json();
}

async function deleteRoom(roomId) {
  const response = await fetch(`/api/rooms/${encodeURIComponent(roomId)}`, {
    method: "DELETE"
  });

  if (response.status === 401) {
    window.location.href = "/";
    throw new Error("Unauthorized");
  }

  if (!response.ok && response.status !== 204) {
    throw new Error("Nao foi possivel excluir sala");
  }
}

async function saveRoomScene(roomId, scene, sceneVersion) {
  const response = await fetch(`/api/rooms/${encodeURIComponent(roomId)}/scene`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ scene, sceneVersion })
  });

  if (response.status === 401) {
    window.location.href = "/";
    throw new Error("Unauthorized");
  }

  if (!response.ok) {
    throw new Error("Nao foi possivel salvar a sala");
  }

  return response.json();
}

export default function App() {
  const [rooms, setRooms] = useState([]);
  const [activeRoomId, setActiveRoomId] = useState(() => getRoomIdFromUrl());
  const [status, setStatus] = useState("idle");
  const [loadingRooms, setLoadingRooms] = useState(true);
  const [roomsError, setRoomsError] = useState("");
  const [copied, setCopied] = useState(false);
  const [clientId] = useState(() => Math.random().toString(36).slice(2, 10));
  const [apiReadyToken, setApiReadyToken] = useState(0);

  const excalidrawApiRef = useRef(null);
  const socketRef = useRef(null);
  const suppressNextBroadcastRef = useRef(false);
  const lastSentSceneVersionRef = useRef(0);
  const pendingSceneRef = useRef(null);
  const pendingSceneVersionRef = useRef(0);
  const latestIncomingSceneRef = useRef(null);
  const latestIncomingSceneVersionRef = useRef(0);
  const hasIncomingSceneScheduledRef = useRef(false);
  const lastAppliedRemoteSceneVersionRef = useRef(0);
  const latestSceneRef = useRef({
    scene: { elements: [], files: {} },
    sceneVersion: 0
  });

  function applyIncomingSceneNow() {
    if (!excalidrawApiRef.current || !latestIncomingSceneRef.current) {
      return;
    }

    suppressNextBroadcastRef.current = true;
    latestSceneRef.current = {
      scene: latestIncomingSceneRef.current,
      sceneVersion: latestIncomingSceneVersionRef.current
    };
    lastAppliedRemoteSceneVersionRef.current = latestIncomingSceneVersionRef.current;
    excalidrawApiRef.current.updateScene({
      elements: latestIncomingSceneRef.current.elements || [],
      files: latestIncomingSceneRef.current.files || {}
    });

    latestIncomingSceneRef.current = null;
  }

  function scheduleApplyIncomingScene() {
    if (hasIncomingSceneScheduledRef.current) {
      return;
    }

    hasIncomingSceneScheduledRef.current = true;
    requestAnimationFrame(() => {
      hasIncomingSceneScheduledRef.current = false;
      applyIncomingSceneNow();
    });
  }

  function getSceneVersion(elements = []) {
    let version = 0;
    for (const element of elements) {
      version += Number(element.version || 0);
      version += Number(element.versionNonce || 0);
      version += Number(element.isDeleted ? 1 : 0);
    }
    return version;
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

  const shareLink = useMemo(() => {
    const url = new URL(window.location.href);
    if (activeRoomId) {
      url.searchParams.set("room", activeRoomId);
    }
    return url.toString();
  }, [activeRoomId]);

  useEffect(() => {
    let cancelled = false;

    async function loadRooms() {
      try {
        setLoadingRooms(true);
        setRoomsError("");

        const data = await fetchRooms();
        if (cancelled) {
          return;
        }

        let nextRooms = Array.isArray(data.rooms) ? data.rooms : [];
        let nextRoomId = activeRoomId;

        if (nextRoomId) {
          const roomExists = nextRooms.some((room) => room.id === nextRoomId);
          if (!roomExists) {
            const created = await createRoom(nextRoomId);
            nextRooms = [created.room, ...nextRooms];
          }
        } else if (nextRooms.length > 0) {
          nextRoomId = nextRooms[0].id;
        } else {
          const created = await createRoom();
          nextRooms = [created.room];
          nextRoomId = created.room.id;
        }

        if (cancelled) {
          return;
        }

        setRooms(nextRooms);
        setActiveRoomId(nextRoomId);
        syncRoomIdInUrl(nextRoomId);
      } catch (error) {
        if (!cancelled) {
          setRoomsError(error.message || "Erro ao carregar salas");
        }
      } finally {
        if (!cancelled) {
          setLoadingRooms(false);
        }
      }
    }

    loadRooms();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (activeRoomId) {
      syncRoomIdInUrl(activeRoomId);
    }
  }, [activeRoomId]);

  useEffect(() => {
    pendingSceneRef.current = null;
    lastSentSceneVersionRef.current = 0;
    pendingSceneVersionRef.current = 0;
    latestIncomingSceneRef.current = null;
    latestIncomingSceneVersionRef.current = 0;
    hasIncomingSceneScheduledRef.current = false;
    lastAppliedRemoteSceneVersionRef.current = 0;
    suppressNextBroadcastRef.current = false;
  }, [activeRoomId]);

  useEffect(() => {
    if (loadingRooms || activeRoomId || rooms.length > 0) {
      return;
    }

    let cancelled = false;

    createRoom()
      .then((created) => {
        if (cancelled) {
          return;
        }

        setRooms((currentRooms) => [created.room, ...currentRooms]);
        setActiveRoomId(created.room.id);
      })
      .catch((error) => {
        if (!cancelled) {
          setRoomsError(error.message || "Nao foi possivel criar sala");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [loadingRooms, activeRoomId, rooms.length]);

  useEffect(() => {
    if (!pendingSceneRef.current || !excalidrawApiRef.current) {
      return;
    }

    suppressNextBroadcastRef.current = true;
    latestSceneRef.current = {
      scene: pendingSceneRef.current,
      sceneVersion: pendingSceneVersionRef.current || lastSentSceneVersionRef.current
    };
    lastAppliedRemoteSceneVersionRef.current = Number(latestSceneRef.current.sceneVersion || 0);
    excalidrawApiRef.current.updateScene({
      elements: pendingSceneRef.current.elements || [],
      files: pendingSceneRef.current.files || {}
    });
    pendingSceneRef.current = null;
  }, [apiReadyToken, activeRoomId]);

  useEffect(() => {
    if (!activeRoomId) {
      return undefined;
    }

    const socketProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const socketUrl = `${socketProtocol}//${window.location.host}/ws`;

    const ws = new WebSocket(socketUrl);
    socketRef.current = ws;
    setStatus("connecting");

    ws.addEventListener("open", () => {
      setStatus("connected");
      ws.send(JSON.stringify({ type: "join-room", roomId: activeRoomId }));
    });

    ws.addEventListener("close", (event) => {
      setStatus("disconnected");
      if (event.code === 4401) {
        window.location.href = "/";
      }
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

      if (payload.type === "room-deleted") {
        setRooms((currentRooms) => {
          const nextRooms = currentRooms.filter((room) => room.id !== payload.roomId);
          if (payload.roomId === activeRoomId) {
            setActiveRoomId(nextRooms[0]?.id || "");
          }
          return nextRooms;
        });
        if (payload.roomId === activeRoomId) {
          pendingSceneRef.current = null;
        }
        return;
      }

      if (payload.type === "rooms-updated") {
        fetchRooms()
          .then((data) => {
            setRooms(Array.isArray(data.rooms) ? data.rooms : []);
          })
          .catch(() => {
            // Mantem a lista atual se o refresh falhar.
          });
        return;
      }

      if (payload.type !== "scene-sync" || !payload.scene) {
        return;
      }

      if (payload.sourceClientId === clientId) {
        return;
      }

      const incomingSceneVersion = Number(payload.sceneVersion || 0);
      if (incomingSceneVersion <= lastAppliedRemoteSceneVersionRef.current) {
        return;
      }

      if (!excalidrawApiRef.current) {
        const currentScene = latestSceneRef.current.scene || { elements: [], files: {} };
        pendingSceneRef.current = {
          elements: mergeElements(currentScene.elements || [], payload.scene.elements || []),
          files: {
            ...(currentScene.files || {}),
            ...(payload.scene.files || {})
          }
        };
        pendingSceneVersionRef.current = incomingSceneVersion;
        return;
      }

      const currentScene = latestSceneRef.current.scene || { elements: [], files: {} };
      const mergedScene = {
        elements: mergeElements(currentScene.elements || [], payload.scene.elements || []),
        files: {
          ...(currentScene.files || {}),
          ...(payload.scene.files || {})
        }
      };

      if (incomingSceneVersion > latestIncomingSceneVersionRef.current) {
        latestIncomingSceneRef.current = mergedScene;
        latestIncomingSceneVersionRef.current = incomingSceneVersion;
      }

      scheduleApplyIncomingScene();
    });

    return () => {
      ws.close();
      socketRef.current = null;
    };
  }, [activeRoomId, clientId]);

  async function copyRoomLink() {
    await navigator.clipboard.writeText(shareLink);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  async function handleLogout() {
    await fetch("/api/logout", {
      method: "POST"
    });
    window.location.reload();
  }

  async function flushCurrentScene() {
    if (!activeRoomId) {
      return;
    }

    const { scene, sceneVersion } = latestSceneRef.current;
    if (!scene) {
      return;
    }

    const result = await saveRoomScene(activeRoomId, scene, sceneVersion || lastSentSceneVersionRef.current);
    setRooms((currentRooms) =>
      currentRooms.map((room) => (room.id === result.room.id ? result.room : room))
    );
  }

  async function handleCreateRoom() {
    await flushCurrentScene().catch(() => {
      // Se o salvamento falhar, ainda deixamos a criacao seguir.
    });
    const created = await createRoom();
    setRooms((currentRooms) => [created.room, ...currentRooms.filter((room) => room.id !== created.room.id)]);
    setActiveRoomId(created.room.id);
  }

  async function handleOpenRoom(roomId) {
    if (roomId === activeRoomId) {
      return;
    }

    await flushCurrentScene().catch(() => {
      // Mantem a navegacao mesmo se o ultimo autosave falhar.
    });
    setActiveRoomId(roomId);
  }

  async function handleDeleteRoom(roomId) {
    if (roomId === activeRoomId) {
      await flushCurrentScene().catch(() => {
        // Se falhar, seguimos para a exclusao mesmo assim.
      });
    }

    await deleteRoom(roomId);
    setRooms((currentRooms) => {
      const nextRooms = currentRooms.filter((room) => room.id !== roomId);
      if (roomId === activeRoomId) {
        setActiveRoomId(nextRooms[0]?.id || "");
      }
      return nextRooms;
    });

    if (roomId === activeRoomId && rooms.filter((room) => room.id !== roomId).length === 0) {
      const created = await createRoom();
      setRooms((currentRooms) => [created.room, ...currentRooms]);
      setActiveRoomId(created.room.id);
    }
  }

  function handleChange(elements, appState, files) {
    if (suppressNextBroadcastRef.current) {
      suppressNextBroadcastRef.current = false;
      return;
    }

    const sceneVersion = getSceneVersion(elements);
    if (sceneVersion === lastSentSceneVersionRef.current) {
      return;
    }
    lastSentSceneVersionRef.current = sceneVersion;
    latestSceneRef.current = {
      scene: { elements, files },
      sceneVersion
    };

    const ws = socketRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return;
    }

    ws.send(
      JSON.stringify({
        type: "scene-update",
        roomId: activeRoomId,
        sceneVersion,
        sourceClientId: clientId,
        scene: {
          elements,
          files
        }
      })
    );
  }

  return (
    <main className="app-shell">
      <header className="app-header">
        <div className="title-wrap">
          <span>Excalidraw</span>
          <small>Sala: {activeRoomId || "-"}</small>
          <small>Status: {status}</small>
        </div>
        <div className="header-actions">
          <button type="button" onClick={handleCreateRoom} className="copy-btn">
            Nova sala
          </button>
          <button type="button" onClick={handleLogout} className="copy-btn">
            Sair
          </button>
          <button type="button" onClick={copyRoomLink} className="copy-btn">
            {copied ? "Link copiado" : "Copiar link"}
          </button>
        </div>
      </header>
      <section className="workspace-layout">
        <aside className="rooms-panel">
          <div className="rooms-panel__title">
            <strong>Salas salvas</strong>
            {loadingRooms ? <small>Carregando...</small> : null}
          </div>
          {roomsError ? <p className="rooms-error">{roomsError}</p> : null}
          <div className="rooms-list">
            {rooms.length === 0 ? <p className="rooms-empty">Nenhuma sala criada.</p> : null}
            {rooms.map((room) => (
              <div key={room.id} className={room.id === activeRoomId ? "room-item room-item--active" : "room-item"}>
                <button type="button" className="room-item__open" onClick={() => handleOpenRoom(room.id)}>
                  <span>{room.id}</span>
                  <small>{new Date(room.updatedAt).toLocaleString()}</small>
                </button>
                <button
                  type="button"
                  className="room-item__delete"
                  onClick={() => handleDeleteRoom(room.id)}
                >
                  Excluir
                </button>
              </div>
            ))}
          </div>
        </aside>
        <section className="canvas-wrap">
          {activeRoomId ? (
            <Excalidraw
              key={activeRoomId}
              excalidrawAPI={(api) => {
                excalidrawApiRef.current = api;
                setApiReadyToken((value) => value + 1);
              }}
              onChange={handleChange}
            />
          ) : null}
        </section>
      </section>
    </main>
  );
}
