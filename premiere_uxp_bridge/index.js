/* global WebSocket */

// This plugin intentionally accepts only one read-only RPC method.  Do not add
// eval(), arbitrary scripts, or UI automation here: every new operation should
// be an explicit, reviewed bridge method.
const ppro = require("premierepro");
const { entrypoints } = require("uxp");

// UXP only trusts publicly-issued certificates (not self-signed / mkcert /
// private-CA / macOS-keychain trust). So the panel must connect to a hostname
// that resolves to 127.0.0.1 (via /etc/hosts) and is covered by a public-CA
// (e.g. Let's Encrypt) certificate the Python bridge serves.
//
// To use your own hostname, change it BOTH here and in manifest.json's
// requiredPermissions.network.domains (they must match). See README.md.
const BRIDGE_URL = "wss://pr-bridge.gospelo.dev:47653";
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
      const params = message.params || {};
      let result;
      if (message.method === "project.assets.list") {
        result = await listProjectAssets(Boolean(params.includeBins));
      } else if (message.method === "sequence.getState") {
        result = await getSequenceState(Boolean(params.debug));
      } else if (message.method === "program.exportFrame") {
        result = await exportProgramFrame(params);
      } else if (message.method === "project.create") {
        result = await createProject(params);
      } else if (message.method === "sequence.insertClip") {
        result = await insertClip(params);
      } else if (message.method === "sequence.addMarker") {
        result = await addMarker(params);
      } else {
        throw new Error(`Unsupported bridge method: ${message.method}`);
      }
      send({ type: "response", id: message.id, ok: true, result });
    } catch (error) {
      const requestId = safeRequestId(event.data);
      if (requestId) {
        send({ type: "response", id: requestId, ok: false, error: String(error.message || error) });
      }
      setStatus(`Bridge request failed: ${String(error.message || error)}`, true);
    }
  };
  // Diagnostics use console.error because the UXP Developer Tool APP LOGS panel
  // only surfaces Error/Warning entries. onclose's code/reason is the key signal
  // when a TLS trust failure otherwise looks like a plain disconnect.
  socket.onerror = (event) => {
    console.error(
      "[bridge] onerror:",
      (event && (event.message || event.error || event.reason || event.type)) || "no-detail",
    );
    setStatus("Bridge connection failed. Verify the trusted TLS certificate and token.", true);
  };
  socket.onclose = (event) => {
    console.error(
      "[bridge] onclose: code=" + (event && event.code) +
        " reason=" + JSON.stringify(event && event.reason) +
        " wasClean=" + (event && event.wasClean),
    );
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

// ---- sequence.getState (L1 structured observation) --------------------------
// Premiere's UXP DOM method names vary by version and fail silently when wrong,
// so every host-API call is wrapped: failures land in `diagnostics` (with the
// exact error) instead of blanking the whole result. Pass debug=true to also
// attach `_reflect` (available method names) so one live call reveals the real
// API surface. This method is read-only.

const TICKS_PER_SECOND = 254016000000;

function tickTimeToSeconds(t) {
  if (t == null) return null;
  if (typeof t === "number") return t / TICKS_PER_SECOND;
  if (typeof t.seconds === "number") return t.seconds;
  if (typeof t.ticks === "number") return t.ticks / TICKS_PER_SECOND;
  if (typeof t.ticks === "string") {
    const n = Number(t.ticks);
    if (!Number.isNaN(n)) return n / TICKS_PER_SECOND;
  }
  return null;
}

function makeSafe(diagnostics) {
  return async (label, fn, fallback) => {
    try {
      return await fn();
    } catch (error) {
      diagnostics.push(`${label}: ${String((error && (error.message || error)) || error)}`);
      return fallback;
    }
  };
}

function reflectMethods(obj) {
  if (obj === null || obj === undefined) return null;
  const names = new Set();
  let proto = obj;
  for (let depth = 0; depth < 3 && proto; depth++) {
    for (const name of Object.getOwnPropertyNames(proto)) names.add(name);
    proto = Object.getPrototypeOf(proto);
  }
  return Array.from(names).sort();
}

async function getTrackItems(track) {
  const trackItemType = (ppro.Constants && ppro.Constants.TrackItemType) || {};
  const clipType = trackItemType.CLIP !== undefined ? trackItemType.CLIP : 1;
  return await track.getTrackItems(clipType, false);
}

async function readTrackItem(item, safe) {
  const out = {};
  // TrackItem exposes getName() (a method), unlike ProjectItem's name property.
  out.name = await safe("item.getName", async () => await item.getName(), null);
  out.startSeconds = await safe("item.getStartTime", async () => tickTimeToSeconds(await item.getStartTime()), null);
  out.endSeconds = await safe("item.getEndTime", async () => tickTimeToSeconds(await item.getEndTime()), null);
  out.inSeconds = await safe("item.getInPoint", async () => tickTimeToSeconds(await item.getInPoint()), null);
  out.outSeconds = await safe("item.getOutPoint", async () => tickTimeToSeconds(await item.getOutPoint()), null);
  out.mediaPath = await safe(
    "item.projectItem.mediaPath",
    async () => {
      const projectItem = await item.getProjectItem();
      if (!projectItem) return null;
      return await ppro.ClipProjectItem.cast(projectItem).getMediaFilePath();
    },
    null,
  );
  return out;
}

async function readTrack(sequence, kind, index, safe) {
  const getter = kind === "video" ? "getVideoTrack" : "getAudioTrack";
  const out = { index, kind, name: null, items: [] };
  const track = await safe(`${getter}(${index})`, async () => await sequence[getter](index), null);
  if (!track) return out;
  out.name = await safe(`${kind}Track[${index}].name`, async () => track.name, null);
  const items = (await safe(`${kind}Track[${index}].getTrackItems`, async () => await getTrackItems(track), [])) || [];
  for (const item of items) {
    out.items.push(await readTrackItem(item, safe));
  }
  return out;
}

async function getSequenceState(includeReflection) {
  const project = await ppro.Project.getActiveProject();
  if (!project) throw new Error("No active project is open.");
  const sequence = await project.getActiveSequence();
  if (!sequence) {
    throw new Error("No active sequence. Open a sequence in the timeline, then retry.");
  }

  const diagnostics = [];
  const safe = makeSafe(diagnostics);

  const state = {
    project: {
      name: await safe("project.name", async () => project.name, null),
      path: await safe("project.path", async () => project.path, null),
    },
    sequence: {
      name: await safe("sequence.name", async () => sequence.name, null),
      playheadSeconds: await safe(
        "sequence.getPlayerPosition",
        async () => tickTimeToSeconds(await sequence.getPlayerPosition()),
        null,
      ),
    },
    videoTracks: [],
    audioTracks: [],
    diagnostics,
  };

  const videoCount = await safe("sequence.getVideoTrackCount", async () => await sequence.getVideoTrackCount(), 0);
  const audioCount = await safe("sequence.getAudioTrackCount", async () => await sequence.getAudioTrackCount(), 0);
  state.sequence.videoTrackCount = videoCount;
  state.sequence.audioTrackCount = audioCount;

  for (let i = 0; i < videoCount; i++) {
    state.videoTracks.push(await readTrack(sequence, "video", i, safe));
  }
  for (let i = 0; i < audioCount; i++) {
    state.audioTracks.push(await readTrack(sequence, "audio", i, safe));
  }

  if (includeReflection) {
    state._reflect = { sequence: reflectMethods(sequence) };
    const firstTrack = await safe("reflect.getVideoTrack(0)", async () => (videoCount > 0 ? await sequence.getVideoTrack(0) : null), null);
    state._reflect.track = reflectMethods(firstTrack);
    if (firstTrack) {
      const items = (await safe("reflect.getTrackItems", async () => await getTrackItems(firstTrack), [])) || [];
      state._reflect.trackItem = reflectMethods(items[0]);
    }
  }

  return state;
}

// ---- project.create (disposable test-project setup) -------------------------
// Creates a NEW .prproj at the given path (it becomes the active project),
// optionally imports media files and creates a sequence from them. Intended
// for setting up disposable test projects so that write-method tests never
// touch a real editing project. Existing projects are not modified.

async function collectClipItems(project) {
  const root = await project.getRootItem();
  const items = await ppro.FolderItem.cast(root).getItems();
  const clips = [];
  for (const item of items) {
    const projectItem = ppro.ProjectItem.cast(item);
    const isBinLike =
      projectItem.type === ppro.ProjectItem.TYPE_ROOT || projectItem.type === ppro.ProjectItem.TYPE_BIN;
    if (!isBinLike) clips.push(ppro.ClipProjectItem.cast(item));
  }
  return clips;
}

async function createProject(params) {
  if (!params.path || typeof params.path !== "string") {
    throw new Error("path (absolute .prproj file path) is required.");
  }

  const diagnostics = [];
  const safe = makeSafe(diagnostics);

  const project = await safe("Project.createProject", async () => await ppro.Project.createProject(params.path), null);
  if (!project) {
    const result = { created: false, diagnostics };
    if (params.debug) result._reflect = { projectStatic: reflectMethods(ppro.Project) };
    return result;
  }

  const result = {
    created: true,
    project: {
      name: await safe("project.name", async () => project.name, null),
      path: await safe("project.path", async () => project.path, null),
    },
    importedCount: 0,
    sequence: null,
    diagnostics,
  };

  if (Array.isArray(params.importPaths) && params.importPaths.length > 0) {
    const ok = await safe(
      "project.importFiles",
      async () => await project.importFiles(params.importPaths, true),
      false,
    );
    if (ok) {
      const clips = (await safe("collectClipItems", async () => await collectClipItems(project), [])) || [];
      result.importedCount = clips.length;

      if (typeof params.sequenceName === "string" && params.sequenceName && clips.length > 0) {
        const sequence = await safe(
          "project.createSequenceFromMedia",
          async () => await project.createSequenceFromMedia(params.sequenceName, clips),
          null,
        );
        if (sequence) {
          result.sequence = {
            name: await safe("sequence.name", async () => sequence.name, null),
          };
        }
      }
    }
  }

  if (params.debug) {
    result._reflect = {
      projectStatic: reflectMethods(ppro.Project),
      project: reflectMethods(project),
    };
  }
  return result;
}

// ---- program.exportFrame (L2 visual observation) ----------------------------
// Exports one frame of the active sequence as a still image, so an agent can
// judge the picture itself (color, framing). Read-only: the frame time is
// passed to the exporter directly; the playhead is never moved. The exact
// Exporter/TickTime API surface varies by version, so calls are wrapped the
// same way as sequence.getState, and debug=true attaches _reflect.

async function exportProgramFrame(params) {
  const project = await ppro.Project.getActiveProject();
  if (!project) throw new Error("No active project is open.");
  const sequence = await project.getActiveSequence();
  if (!sequence) {
    throw new Error("No active sequence. Open a sequence in the timeline, then retry.");
  }
  if (!params.outputDir || typeof params.outputDir !== "string") {
    throw new Error("outputDir (absolute directory path) is required.");
  }

  const diagnostics = [];
  const safe = makeSafe(diagnostics);

  // Frame time: explicit seconds, else the current playhead. No seeking.
  let time = null;
  if (params.timeSeconds !== undefined && params.timeSeconds !== null) {
    time = await safe(
      "TickTime.createWithSeconds",
      async () => ppro.TickTime.createWithSeconds(Number(params.timeSeconds)),
      null,
    );
  } else {
    time = await safe("sequence.getPlayerPosition", async () => await sequence.getPlayerPosition(), null);
  }

  // Frame size: explicit, else the sequence's own size.
  let width = params.width || null;
  let height = params.height || null;
  if (!width || !height) {
    const size = await safe("sequence.getFrameSize", async () => await sequence.getFrameSize(), null);
    if (size) {
      width = width || size.width;
      height = height || size.height;
    }
  }

  const fileName = typeof params.fileName === "string" && params.fileName ? params.fileName : "frame.png";
  const result = {
    outputDir: params.outputDir,
    fileName,
    width,
    height,
    timeResolved: time !== null,
    exportReturn: null,
    diagnostics,
  };

  if (params.debug) {
    result._reflect = {
      exporter: reflectMethods(ppro.Exporter),
      tickTime: reflectMethods(ppro.TickTime),
      time: reflectMethods(time),
    };
  }

  if (time === null || !width || !height) {
    // Return what we learned instead of throwing, so the first live run
    // reveals the real API via diagnostics/_reflect.
    return result;
  }

  result.exportReturn = await safe(
    "Exporter.exportSequenceFrame",
    async () => await ppro.Exporter.exportSequenceFrame(sequence, time, fileName, params.outputDir, width, height),
    null,
  );
  return result;
}

// ---- write methods (stage 3) ------------------------------------------------
// Timeline edits go through Premiere's action/transaction pattern:
// build a create*Action, then commit it inside project.lockedAccess ->
// project.executeTransaction. Each method is a narrow, explicit operation
// (no arbitrary eval), and callers are expected to verify the result with
// sequence.getState (act -> observe).

async function findProjectItemById(project, wantedId) {
  const root = await project.getRootItem();

  async function walk(item) {
    const projectItem = ppro.ProjectItem.cast(item);
    if (projectItem.getId() === wantedId) return item;
    const isBinLike =
      projectItem.type === ppro.ProjectItem.TYPE_ROOT || projectItem.type === ppro.ProjectItem.TYPE_BIN;
    if (isBinLike) {
      const children = await ppro.FolderItem.cast(item).getItems();
      for (const child of children) {
        const found = await walk(child);
        if (found) return found;
      }
    }
    return null;
  }

  return await walk(root);
}

function runTransaction(project, buildAction, undoLabel, diagnostics) {
  // lockedAccess/executeTransaction take synchronous callbacks, and the
  // create*Action factories themselves throw "Requires locked access" unless
  // called INSIDE lockedAccess — so the action is built within the callback.
  try {
    project.lockedAccess(() => {
      project.executeTransaction((compoundAction) => {
        compoundAction.addAction(buildAction());
      }, undoLabel);
    });
    return true;
  } catch (error) {
    diagnostics.push(`executeTransaction: ${String((error && (error.message || error)) || error)}`);
    return false;
  }
}

async function insertClip(params) {
  const project = await ppro.Project.getActiveProject();
  if (!project) throw new Error("No active project is open.");
  const sequence = await project.getActiveSequence();
  if (!sequence) throw new Error("No active sequence. Open a sequence in the timeline, then retry.");
  if (!params.projectItemId || typeof params.projectItemId !== "string") {
    throw new Error("projectItemId is required (use project.assets.list to find it).");
  }
  if (params.timeSeconds === undefined || params.timeSeconds === null) {
    throw new Error("timeSeconds is required.");
  }

  const diagnostics = [];
  const safe = makeSafe(diagnostics);

  const item = await safe(
    "findProjectItemById",
    async () => await findProjectItemById(project, params.projectItemId),
    null,
  );
  if (!item) throw new Error(`Project item not found: ${params.projectItemId}`);

  const time = await safe(
    "TickTime.createWithSeconds",
    async () => ppro.TickTime.createWithSeconds(Number(params.timeSeconds)),
    null,
  );
  const editor = await safe("SequenceEditor.getEditor", async () => ppro.SequenceEditor.getEditor(sequence), null);

  const result = {
    inserted: false,
    mode: params.overwrite ? "overwrite" : "insert",
    videoTrackIndex: Number(params.videoTrackIndex || 0),
    audioTrackIndex: Number(params.audioTrackIndex || 0),
    timeSeconds: Number(params.timeSeconds),
    diagnostics,
  };
  if (params.debug) {
    result._reflect = {
      sequenceEditorStatic: reflectMethods(ppro.SequenceEditor),
      editor: reflectMethods(editor),
    };
  }
  if (!time || !editor) return result;

  result.inserted = runTransaction(
    project,
    () =>
      params.overwrite
        ? editor.createOverwriteItemAction(item, time, result.videoTrackIndex, result.audioTrackIndex)
        : editor.createInsertProjectItemAction(
            item,
            time,
            result.videoTrackIndex,
            result.audioTrackIndex,
            Boolean(params.limitShift),
          ),
    "Gospelo bridge: insert clip",
    diagnostics,
  );
  return result;
}

async function addMarker(params) {
  const project = await ppro.Project.getActiveProject();
  if (!project) throw new Error("No active project is open.");
  const sequence = await project.getActiveSequence();
  if (!sequence) throw new Error("No active sequence. Open a sequence in the timeline, then retry.");
  if (!params.name || typeof params.name !== "string") {
    throw new Error("name is required.");
  }
  if (params.timeSeconds === undefined || params.timeSeconds === null) {
    throw new Error("timeSeconds is required.");
  }

  const diagnostics = [];
  const safe = makeSafe(diagnostics);

  const markers = await safe("Markers.getMarkers", async () => await ppro.Markers.getMarkers(sequence), null);
  const startTime = await safe(
    "TickTime.createWithSeconds(start)",
    async () => ppro.TickTime.createWithSeconds(Number(params.timeSeconds)),
    null,
  );
  const duration =
    params.durationSeconds !== undefined && params.durationSeconds !== null
      ? await safe(
          "TickTime.createWithSeconds(duration)",
          async () => ppro.TickTime.createWithSeconds(Number(params.durationSeconds)),
          null,
        )
      : null;

  const result = {
    added: false,
    name: params.name,
    timeSeconds: Number(params.timeSeconds),
    markerCount: null,
    diagnostics,
  };
  if (params.debug) {
    result._reflect = {
      markersStatic: reflectMethods(ppro.Markers),
      markers: reflectMethods(markers),
    };
  }
  if (!markers || !startTime) return result;

  result.added = runTransaction(
    project,
    () =>
      markers.createAddMarkerAction(
        params.name,
        typeof params.markerType === "string" ? params.markerType : "Comment",
        startTime,
        duration || undefined,
        typeof params.comments === "string" ? params.comments : undefined,
      ),
    "Gospelo bridge: add marker",
    diagnostics,
  );

  // Read back the marker count so the caller gets immediate confirmation.
  const list = (await safe("markers.getMarkers", async () => await markers.getMarkers(), null)) || null;
  if (list && typeof list.length === "number") result.markerCount = list.length;
  return result;
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
