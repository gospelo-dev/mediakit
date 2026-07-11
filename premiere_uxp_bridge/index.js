/* global WebSocket */

// This plugin intentionally accepts only one read-only RPC method.  Do not add
// eval(), arbitrary scripts, or UI automation here: every new operation should
// be an explicit, reviewed bridge method.
const ppro = require("premierepro");
const { entrypoints } = require("uxp");

const BRIDGE_URL = "wss://127.0.0.1:47653";
let socket = null;
let reconnectTimer = null;
let currentToken = "";

function setStatus(text, isError = false) {
  const element = document.getElementById("status");
  if (!element) return;
  element.textContent = text;
  element.style.color = isError ? "#ffb4ab" : "#a8e6cf";
}

function scheduleReconnect() {
  if (!currentToken || reconnectTimer !== null) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, 2000);
}

function connect() {
  const tokenInput = document.getElementById("token");
  currentToken = tokenInput ? tokenInput.value.trim() : currentToken;
  if (!currentToken) {
    setStatus("Enter the bridge token before connecting.", true);
    return;
  }

  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }

  setStatus("Connecting to the local MCP bridge…");
  socket = new WebSocket(BRIDGE_URL);
  socket.onopen = () => {
    socket.send(
      JSON.stringify({
        type: "hello",
        token: currentToken,
        client: "gospelo-premiere-uxp",
        protocolVersion: 1,
      }),
    );
  };
  socket.onmessage = async (event) => {
    try {
      const message = JSON.parse(event.data);
      if (message.type === "hello_ack") {
        setStatus("Connected. Keep this panel open.");
        return;
      }
      if (message.type !== "request" || typeof message.id !== "string") {
        throw new Error("Invalid bridge request.");
      }
      if (message.method !== "project.assets.list") {
        throw new Error(`Unsupported bridge method: ${message.method}`);
      }
      const result = await listProjectAssets(Boolean(message.params && message.params.includeBins));
      send({ type: "response", id: message.id, ok: true, result });
    } catch (error) {
      const requestId = safeRequestId(event.data);
      if (requestId) {
        send({ type: "response", id: requestId, ok: false, error: String(error.message || error) });
      }
      setStatus(`Bridge request failed: ${String(error.message || error)}`, true);
    }
  };
  socket.onerror = () => setStatus("Bridge connection failed. Verify the trusted TLS certificate and token.", true);
  socket.onclose = () => {
    socket = null;
    setStatus("Bridge disconnected; retrying…", true);
    scheduleReconnect();
  };
}

function send(message) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function safeRequestId(rawMessage) {
  try {
    const message = JSON.parse(rawMessage);
    return typeof message.id === "string" ? message.id : null;
  } catch (_) {
    return null;
  }
}

async function listProjectAssets(includeBins) {
  const project = await ppro.Project.getActiveProject();
  const root = await project.getRootItem();
  const assets = [];
  await visitProjectItem(root, null, includeBins, assets);

  return {
    project: {
      id: project.guid.toString(),
      name: project.name,
      path: project.path,
    },
    assets,
  };
}

async function visitProjectItem(item, parentId, includeBins, assets) {
  const projectItem = ppro.ProjectItem.cast(item);
  const id = projectItem.getId();
  const isRoot = projectItem.type === ppro.ProjectItem.TYPE_ROOT;
  const isBin = projectItem.type === ppro.ProjectItem.TYPE_BIN;

  if (isRoot || isBin) {
    if (includeBins) {
      assets.push({
        id,
        parentId,
        name: projectItem.name,
        kind: isRoot ? "root" : "bin",
        mediaPath: null,
        offline: false,
      });
    }
    const children = await ppro.FolderItem.cast(item).getItems();
    for (const child of children) {
      await visitProjectItem(child, id, includeBins, assets);
    }
    return;
  }

  const clip = ppro.ClipProjectItem.cast(item);
  const isSequence = await clip.isSequence();
  assets.push({
    id,
    parentId,
    name: projectItem.name,
    kind: isSequence ? "sequence" : "media",
    mediaPath: isSequence ? null : await safeMediaPath(clip),
    offline: isSequence ? false : await clip.isOffline(),
  });
}

async function safeMediaPath(clip) {
  try {
    return await clip.getMediaFilePath();
  } catch (_) {
    return null;
  }
}

entrypoints.setup({
  panels: {
    "gospelo-premiere-bridge-panel": {
      create() {
        document.getElementById("connect").addEventListener("click", connect);
      },
      show() {
        if (currentToken) connect();
      },
    },
  },
});
