/* global WebSocket */

// This plugin intentionally accepts only one read-only RPC method.  Do not add
// eval(), arbitrary scripts, or UI automation here: every new operation should
// be an explicit, reviewed bridge method.
const ppro = require("premierepro");
const { entrypoints } = require("uxp");
const { secureStorage } = require("uxp").storage;

// The bridge token is kept in UXP secureStorage (encrypted, per-plugin) so it
// survives panel reloads without re-entry. It is saved only after a
// successful authenticated connect, and removed via the "Forget token" button.
const TOKEN_STORAGE_KEY = "gospeloBridgeToken";

// Premiere's UXP runtime has no TextEncoder/TextDecoder, so convert the
// (ASCII) token to bytes manually.
function tokenToBytes(token) {
  return Uint8Array.from(token, (ch) => ch.charCodeAt(0) & 0xff);
}

function bytesToToken(data) {
  let out = "";
  for (let i = 0; i < data.length; i++) out += String.fromCharCode(data[i]);
  return out;
}

async function saveToken(token) {
  try {
    await secureStorage.setItem(TOKEN_STORAGE_KEY, tokenToBytes(token));
    console.error("[bridge] token saved to secure storage"); // Error level so UDT APP LOGS shows it
  } catch (error) {
    console.error("[bridge] saveToken failed:", String((error && error.message) || error));
  }
}

async function loadSavedToken() {
  try {
    const data = await secureStorage.getItem(TOKEN_STORAGE_KEY);
    if (data && data.length) {
      console.error("[bridge] token restored from secure storage");
      return bytesToToken(data);
    }
    console.error("[bridge] no saved token in secure storage (getItem returned empty)");
  } catch (error) {
    console.error("[bridge] loadSavedToken failed:", String((error && error.message) || error));
  }
  return "";
}

async function forgetToken() {
  try {
    await secureStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch (_) {
    // Nothing stored.
  }
}

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
        await saveToken(currentToken); // persist only tokens that authenticated
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
      } else if (message.method === "sequence.importCaptions") {
        result = await importCaptions(params);
      } else if (message.method === "sequence.insertMogrt") {
        result = await insertMogrt(params);
      } else if (message.method === "project.importMedia") {
        result = await importMedia(params);
      } else if (message.method === "sequence.moveClip") {
        result = await moveClip(params);
      } else if (message.method === "sequence.setTrackMute") {
        result = await setTrackMute(params);
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

  // solo_video_track: temporarily hide every OTHER video track (and unhide
  // the solo track if needed), export, then ALWAYS restore the original
  // mute states — all inside this one bridge call so callers cannot leave
  // the timeline in a half-toggled state.
  const solo =
    params.soloVideoTrack !== undefined && params.soloVideoTrack !== null ? Number(params.soloVideoTrack) : null;
  const toggled = [];
  if (solo !== null) {
    const trackCount = (await safe("getVideoTrackCount(solo)", async () => await sequence.getVideoTrackCount(), 0)) || 0;
    result.soloVideoTrack = solo;
    for (let i = 0; i < trackCount; i++) {
      const track = await safe(`getVideoTrack(${i})`, async () => await sequence.getVideoTrack(i), null);
      if (!track) continue;
      const muted = await safe(`isMuted(${i})`, async () => await track.isMuted(), null);
      const wantMuted = i !== solo;
      if (muted !== null && muted !== wantMuted) {
        const set = await safe(`setMute(${i},${wantMuted})`, async () => await track.setMute(wantMuted), null);
        if (set !== null) toggled.push({ index: i, track, original: muted });
      }
    }
    result.soloToggled = toggled.map((t) => t.index);
  }

  result.exportReturn = await safe(
    "Exporter.exportSequenceFrame",
    async () => await ppro.Exporter.exportSequenceFrame(sequence, time, fileName, params.outputDir, width, height),
    null,
  );

  if (toggled.length > 0) {
    let restored = 0;
    for (const t of toggled) {
      const ok = await safe(`restoreMute(${t.index})`, async () => await t.track.setMute(t.original), null);
      if (ok !== null) restored++;
    }
    result.soloRestored = restored === toggled.length;
  }
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
  // buildAction may return a single action or an array (one atomic undo step).
  try {
    project.lockedAccess(() => {
      project.executeTransaction((compoundAction) => {
        const built = buildAction();
        for (const action of Array.isArray(built) ? built : [built]) {
          compoundAction.addAction(action);
        }
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

async function restoreTokenAndConnect() {
  const saved = await loadSavedToken();
  if (!saved) {
    setStatus("No saved token. Enter the bridge token and press Connect.");
    return;
  }
  currentToken = saved;
  const tokenInput = document.getElementById("token");
  if (tokenInput) tokenInput.value = saved;
  setStatus("Restored saved token. Connecting…");
  connect();
}

function onForget() {
  currentToken = "";
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  const tokenInput = document.getElementById("token");
  if (tokenInput) tokenInput.value = "";
  if (socket) {
    socket.onclose = null; // keep the "forgotten" status; no retry banner
    socket.onerror = null;
    try {
      socket.close();
    } catch (_) {
      // Already closed.
    }
    socket = null;
  }
  forgetToken();
  setStatus("Token forgotten. Enter a bridge token to connect.");
}

// ---- project.importMedia (add media files to the active project) ------------
// Imports files into the active project's root bin via project.importFiles.
// The project bin is modified; the timeline is NOT touched (unlike
// sequence.insertClip). New items are identified by a root-item ID diff so the
// caller can chain insertClip with the returned IDs.

async function importMedia(params) {
  const project = await ppro.Project.getActiveProject();
  if (!project) throw new Error("No active project is open.");
  if (!Array.isArray(params.paths) || params.paths.length === 0) {
    throw new Error("paths (array of absolute media file paths) is required.");
  }

  const diagnostics = [];
  const safe = makeSafe(diagnostics);

  const beforeIds = (await safe("listRootItemIds(before)", async () => await listRootItemIds(project), [])) || [];
  const imported = await safe(
    "project.importFiles",
    async () => await project.importFiles(params.paths, true),
    false,
  );
  const afterIds = (await safe("listRootItemIds(after)", async () => await listRootItemIds(project), [])) || [];
  const newIds = afterIds.filter((id) => !beforeIds.includes(id));

  // Name the new items so the caller can map IDs to files.
  const newItems = [];
  for (const id of newIds) {
    const item = await safe(`findProjectItemById(${id})`, async () => await findProjectItemById(project, id), null);
    newItems.push({ id, name: item ? await safe("item.name", async () => ppro.ProjectItem.cast(item).name, null) : null });
  }

  return {
    imported: Boolean(imported),
    requestedCount: params.paths.length,
    newItems,
    diagnostics,
  };
}

// ---- sequence.moveClip (reposition an existing track item) -------------------
// Finds the clip on the given track whose start time matches itemStartSeconds
// (within a small tolerance) and moves it via trackItem.createMoveAction as a
// single undoable transaction. Whether a linked A/V pair moves together is
// determined by Premiere itself; callers should verify with sequence.getState.

async function moveClip(params) {
  const project = await ppro.Project.getActiveProject();
  if (!project) throw new Error("No active project is open.");
  const sequence = await project.getActiveSequence();
  if (!sequence) throw new Error("No active sequence. Open a sequence in the timeline, then retry.");
  if (params.itemStartSeconds === undefined || params.itemStartSeconds === null) {
    throw new Error("itemStartSeconds is required (identifies the clip to move).");
  }
  if (params.newStartSeconds === undefined || params.newStartSeconds === null) {
    throw new Error("newStartSeconds is required.");
  }

  const diagnostics = [];
  const safe = makeSafe(diagnostics);
  const trackType = params.trackType === "audio" ? "audio" : "video";
  const trackIndex = Number(params.trackIndex || 0);
  const tolerance = params.toleranceSeconds !== undefined ? Number(params.toleranceSeconds) : 0.05;

  const track = await safe(
    `${trackType}Track(${trackIndex})`,
    async () =>
      trackType === "video" ? await sequence.getVideoTrack(trackIndex) : await sequence.getAudioTrack(trackIndex),
    null,
  );
  if (!track) throw new Error(`Track not found: ${trackType}[${trackIndex}]`);

  const items = (await safe("getTrackItems", async () => await getTrackItems(track), [])) || [];
  let target = null;
  let matchedStart = null;
  const starts = [];
  for (const item of items) {
    const start = await safe("item.getStartTime", async () => tickTimeToSeconds(await item.getStartTime()), null);
    starts.push(start);
    if (start !== null && Math.abs(start - Number(params.itemStartSeconds)) <= tolerance) {
      target = item;
      matchedStart = start;
      break;
    }
  }
  if (!target) {
    throw new Error(
      `No clip starting at ${params.itemStartSeconds}s (tolerance ${tolerance}s) on ${trackType}[${trackIndex}]. ` +
        `Clip starts on that track: ${JSON.stringify(starts)}`,
    );
  }

  const name = await safe("item.getName", async () => await target.getName(), null);
  // createMoveAction takes a RELATIVE offset (live-discovered: passing the
  // absolute target committed fine but moved nothing when the offset happened
  // to equal the current position delta of zero). Convert absolute -> offset.
  const offsetSeconds = Number(params.newStartSeconds) - matchedStart;
  const offsetTime = await safe(
    "TickTime.createWithSeconds(offset)",
    async () => ppro.TickTime.createWithSeconds(offsetSeconds),
    null,
  );
  const result = {
    moved: false,
    name,
    fromSeconds: matchedStart,
    toSeconds: Number(params.newStartSeconds),
    offsetSeconds,
    trackType,
    trackIndex,
    diagnostics,
  };
  if (!offsetTime) return result;

  // Same-track move: a plain relative move action.
  if (params.newTrackIndex === undefined || Number(params.newTrackIndex) === trackIndex) {
    result.moved = runTransaction(
      project,
      () => target.createMoveAction(offsetTime),
      "Gospelo bridge: move clip",
      diagnostics,
    );
    return result;
  }

  // Cross-track (vertical) move: no direct API exists, so clone the item to
  // the destination track and remove the original in ONE transaction
  // (atomic, single undo). Selection is needed for the remove action.
  const trackDelta = Number(params.newTrackIndex) - trackIndex;
  result.newTrackIndex = Number(params.newTrackIndex);
  result.trackDelta = trackDelta;

  const editor = await safe("SequenceEditor.getEditor", async () => ppro.SequenceEditor.getEditor(sequence), null);

  // Build a selection containing ONLY our target. clearSelection first so a
  // user's live selection can never leak into the remove action.
  let selection = null;
  await safe("sequence.clearSelection", async () => await sequence.clearSelection(), null);
  selection = await safe("sequence.getSelection", async () => await sequence.getSelection(), null);
  if (selection) {
    const added =
      (await safe("selection.addItem(target)", async () => (selection.addItem(target), true), null)) ||
      (await safe("selection.addItem(target,false)", async () => (selection.addItem(target, false), true), null));
    if (!added) selection = null;
  }
  if (params.debug) {
    result._reflect = {
      selection: reflectMethods(selection),
      mediaTypeKeys: ppro.Constants && ppro.Constants.MediaType ? Object.keys(ppro.Constants.MediaType) : null,
    };
  }
  if (!editor || !selection) return result;

  const mediaType =
    ppro.Constants && ppro.Constants.MediaType
      ? trackType === "video"
        ? ppro.Constants.MediaType.VIDEO
        : ppro.Constants.MediaType.AUDIO
      : null;

  result.moved = runTransaction(
    project,
    () => [
      editor.createCloneTrackItemAction(
        target,
        offsetTime,
        trackType === "video" ? trackDelta : 0,
        trackType === "audio" ? trackDelta : 0,
        trackType === "video",
        false, // overwrite at the destination, do not ripple-insert
      ),
      editor.createRemoveItemsAction(selection, false, mediaType, false),
    ],
    "Gospelo bridge: move clip across tracks",
    diagnostics,
  );
  return result;
}

// ---- sequence.setTrackMute (mute/unmute a track) ------------------------------
// track.setMute is a documented direct setter (not an action/transaction).
// The response reports the observed before/after state so the caller gets an
// act -> observe confirmation in one round trip.

async function setTrackMute(params) {
  const project = await ppro.Project.getActiveProject();
  if (!project) throw new Error("No active project is open.");
  const sequence = await project.getActiveSequence();
  if (!sequence) throw new Error("No active sequence. Open a sequence in the timeline, then retry.");
  if (params.mute === undefined || params.mute === null) {
    throw new Error("mute (true/false) is required.");
  }

  const diagnostics = [];
  const safe = makeSafe(diagnostics);
  const trackType = params.trackType === "video" ? "video" : "audio";
  const trackIndex = Number(params.trackIndex || 0);

  const track = await safe(
    `${trackType}Track(${trackIndex})`,
    async () =>
      trackType === "video" ? await sequence.getVideoTrack(trackIndex) : await sequence.getAudioTrack(trackIndex),
    null,
  );
  if (!track) throw new Error(`Track not found: ${trackType}[${trackIndex}]`);

  const before = await safe("isMuted(before)", async () => await track.isMuted(), null);
  const setReturn = await safe("setMute", async () => await track.setMute(Boolean(params.mute)), null);
  const after = await safe("isMuted(after)", async () => await track.isMuted(), null);

  return {
    trackType,
    trackIndex,
    requested: Boolean(params.mute),
    mutedBefore: before,
    mutedAfter: after,
    changed: before !== after,
    setReturn,
    diagnostics,
  };
}

// ---- sequence.importCaptions (SRT -> caption track) --------------------------
// Imports an SRT file into the project and attempts to place it on the active
// sequence, which in the UI creates a caption track. Premiere's caption API
// is still immature, so this method is deliberately observational: it reports
// caption-track counts before/after and rich diagnostics/_reflect so a failed
// placement tells us exactly which step needs a different API.

async function listRootItemIds(project) {
  const root = await project.getRootItem();
  const items = await ppro.FolderItem.cast(root).getItems();
  const ids = [];
  for (const item of items) {
    ids.push(ppro.ProjectItem.cast(item).getId());
  }
  return ids;
}

async function importCaptions(params) {
  const project = await ppro.Project.getActiveProject();
  if (!project) throw new Error("No active project is open.");
  const sequence = await project.getActiveSequence();
  if (!sequence) throw new Error("No active sequence. Open a sequence in the timeline, then retry.");
  if (!params.srtPath || typeof params.srtPath !== "string") {
    throw new Error("srtPath (absolute .srt file path) is required.");
  }

  const diagnostics = [];
  const safe = makeSafe(diagnostics);

  const before = {
    itemIds: (await safe("listRootItemIds(before)", async () => await listRootItemIds(project), [])) || [],
    captionTracks: await safe(
      "getCaptionTrackCount(before)",
      async () => await sequence.getCaptionTrackCount(),
      null,
    ),
  };

  const imported = await safe(
    "project.importFiles(srt)",
    async () => await project.importFiles([params.srtPath], true),
    false,
  );

  const afterIds = (await safe("listRootItemIds(after)", async () => await listRootItemIds(project), [])) || [];
  const newIds = afterIds.filter((id) => !before.itemIds.includes(id));

  const result = {
    imported: Boolean(imported),
    newItemIds: newIds,
    placed: false,
    captionTracksBefore: before.captionTracks,
    captionTracksAfter: null,
    diagnostics,
  };

  let newItem = null;
  if (newIds.length > 0) {
    newItem = await safe(
      "findProjectItemById(newItem)",
      async () => await findProjectItemById(project, newIds[0]),
      null,
    );
  }

  if (newItem) {
    const time = await safe(
      "TickTime.createWithSeconds",
      async () => ppro.TickTime.createWithSeconds(Number(params.timeSeconds || 0)),
      null,
    );
    const editor = await safe("SequenceEditor.getEditor", async () => ppro.SequenceEditor.getEditor(sequence), null);
    if (time && editor) {
      // Known limitation: for caption items this transaction commits but is a
      // silent no-op (Premiere's caption API is not public yet). We attempt it
      // anyway so a future Premiere that supports it starts working, and judge
      // success by the OBSERVED caption-track delta below, not by the commit.
      runTransaction(
        project,
        () => editor.createInsertProjectItemAction(newItem, time, 0, 0, false),
        "Gospelo bridge: place captions",
        diagnostics,
      );
    }
  }

  result.captionTracksAfter = await safe(
    "getCaptionTrackCount(after)",
    async () => await sequence.getCaptionTrackCount(),
    null,
  );
  result.placed =
    typeof result.captionTracksAfter === "number" &&
    typeof result.captionTracksBefore === "number" &&
    result.captionTracksAfter > result.captionTracksBefore;
  if (result.imported && !result.placed) {
    result.note =
      "SRT imported into the project bin, but automatic timeline placement is " +
      "not supported by Premiere's current UXP API. Drag the imported captions " +
      "item from the Project panel onto the sequence once; Premiere will create " +
      "the caption track with all cues.";
  }

  if (params.debug) {
    result._reflect = {
      newItem: reflectMethods(newItem),
      captionTrack: reflectMethods(
        await safe(
          "getCaptionTrack(0)",
          async () =>
            (await sequence.getCaptionTrackCount()) > 0 ? await sequence.getCaptionTrack(0) : null,
          null,
        ),
      ),
      // Inventory of the ppro module: which classes exist at all (looking for
      // any caption-related creation API the docs do not mention yet).
      pproKeys: Object.keys(ppro).sort(),
      captionTrackStatic: ppro.CaptionTrack ? reflectMethods(ppro.CaptionTrack) : null,
      sequenceUtilsStatic: ppro.SequenceUtils ? reflectMethods(ppro.SequenceUtils) : null,
      transcriptStatic: ppro.Transcript ? reflectMethods(ppro.Transcript) : null,
      textSegmentsStatic: ppro.TextSegments ? reflectMethods(ppro.TextSegments) : null,
      projectUtilsStatic: ppro.ProjectUtils ? reflectMethods(ppro.ProjectUtils) : null,
    };
  }

  // Experimental probing of the UNDOCUMENTED editor.createAddItemAction /
  // createAddItemsAction (present at runtime, absent from even the beta
  // type definitions). Error messages reveal the expected signature.
  if (params.experiment && newItem) {
    const editor = await safe("SequenceEditor.getEditor(exp)", async () => ppro.SequenceEditor.getEditor(sequence), null);
    const time = await safe(
      "TickTime.createWithSeconds(exp)",
      async () => ppro.TickTime.createWithSeconds(Number(params.timeSeconds || 0)),
      null,
    );
    const experiment = {
      addItemArity: editor && editor.createAddItemAction ? editor.createAddItemAction.length : null,
      addItemsArity: editor && editor.createAddItemsAction ? editor.createAddItemsAction.length : null,
      attempts: [],
    };
    if (editor && time) {
      const variants = [
        { label: "addItem(item, time, 0, 0)", build: () => editor.createAddItemAction(newItem, time, 0, 0) },
        { label: "addItem(item, time, 0, 0, false)", build: () => editor.createAddItemAction(newItem, time, 0, 0, false) },
        { label: "addItem(item, time, 0, 0, 0)", build: () => editor.createAddItemAction(newItem, time, 0, 0, 0) },
        { label: "addItem(item, 0, time, 0)", build: () => editor.createAddItemAction(newItem, 0, time, 0) },
      ];
      experiment.trackItemSelectionStatic = ppro.TrackItemSelection
        ? reflectMethods(ppro.TrackItemSelection)
        : null;
      for (const variant of variants) {
        const attempt = { label: variant.label, committed: false, error: null };
        try {
          project.lockedAccess(() => {
            project.executeTransaction((compoundAction) => {
              compoundAction.addAction(variant.build());
            }, `Gospelo experiment: ${variant.label}`);
          });
          attempt.committed = true;
        } catch (error) {
          attempt.error = String((error && (error.message || error)) || error);
        }
        attempt.captionTracksNow = await safe(
          `captionCount(${variant.label})`,
          async () => await sequence.getCaptionTrackCount(),
          null,
        );
        experiment.attempts.push(attempt);
        // Stop early if a caption track actually appeared.
        if (
          typeof attempt.captionTracksNow === "number" &&
          typeof result.captionTracksBefore === "number" &&
          attempt.captionTracksNow > result.captionTracksBefore
        ) {
          break;
        }
      }
    }
    result._experiment = experiment;
  }
  return result;
}

// ---- sequence.insertMogrt (editable text telop via Motion Graphics template) --
// Inserts a .mogrt at a given time/track and, when `text` is given, rewrites
// the template's text parameter so the telop content is fully programmatic AND
// remains editable in Premiere's Essential Graphics panel. Without mogrtPath
// this acts as reconnaissance and only returns the installed-mogrt directory.

async function insertMogrt(params) {
  const project = await ppro.Project.getActiveProject();
  if (!project) throw new Error("No active project is open.");
  const sequence = await project.getActiveSequence();
  if (!sequence) throw new Error("No active sequence. Open a sequence in the timeline, then retry.");

  const diagnostics = [];
  const safe = makeSafe(diagnostics);

  // Reconnaissance mode: where do Premiere's bundled .mogrt files live?
  if (!params.mogrtPath) {
    const installed = await safe(
      "SequenceEditor.getInstalledMogrtPath",
      async () => await ppro.SequenceEditor.getInstalledMogrtPath(),
      null,
    );
    return { installedMogrtPath: installed, diagnostics };
  }

  const editor = await safe("SequenceEditor.getEditor", async () => ppro.SequenceEditor.getEditor(sequence), null);
  const time = await safe(
    "TickTime.createWithSeconds",
    async () => ppro.TickTime.createWithSeconds(Number(params.timeSeconds || 0)),
    null,
  );
  const videoTrackIndex = Number(params.videoTrackIndex || 0);
  const audioTrackIndex = Number(params.audioTrackIndex || 0);

  const result = {
    inserted: false,
    itemCount: 0,
    components: [],
    textSet: false,
    textParam: null,
    diagnostics,
  };
  if (!editor || !time) return result;

  // insertMogrtFromPath is synchronous per the type definitions and (like the
  // create*Action factories) must run inside lockedAccess.
  let insertedItems = null;
  try {
    project.lockedAccess(() => {
      insertedItems = editor.insertMogrtFromPath(params.mogrtPath, time, videoTrackIndex, audioTrackIndex);
    });
  } catch (error) {
    diagnostics.push(`insertMogrtFromPath: ${String((error && (error.message || error)) || error)}`);
  }
  if (!insertedItems || !insertedItems.length) return result;
  result.inserted = true;
  result.itemCount = insertedItems.length;

  const videoItem = insertedItems[0];

  // Match the telop's on-screen duration to the caption cue: mogrt clips get
  // a fixed default duration, so trim the end when durationSeconds is given.
  if (params.durationSeconds !== undefined && params.durationSeconds !== null) {
    const endTime = await safe(
      "TickTime.createWithSeconds(end)",
      async () =>
        ppro.TickTime.createWithSeconds(Number(params.timeSeconds || 0) + Number(params.durationSeconds)),
      null,
    );
    if (endTime) {
      result.durationSet = runTransaction(
        project,
        () => videoItem.createSetEndAction(endTime),
        "Gospelo bridge: set telop duration",
        diagnostics,
      );
    } else {
      result.durationSet = false;
    }
  }

  // Inventory the component chain of the first (video) item to find the text param.
  const chain = await safe("getComponentChain", async () => await videoItem.getComponentChain(), null);
  if (!chain) return result;

  let textParamRef = null;
  const componentCount = (await safe("getComponentCount", async () => chain.getComponentCount(), 0)) || 0;
  for (let ci = 0; ci < componentCount; ci++) {
    const component = await safe(`getComponentAtIndex(${ci})`, async () => chain.getComponentAtIndex(ci), null);
    if (!component) continue;
    const info = {
      matchName: await safe(`component[${ci}].getMatchName`, async () => await component.getMatchName(), null),
      displayName: await safe(`component[${ci}].getDisplayName`, async () => await component.getDisplayName(), null),
      params: [],
    };
    const paramCount = (await safe(`component[${ci}].getParamCount`, async () => component.getParamCount(), 0)) || 0;
    for (let pi = 0; pi < paramCount; pi++) {
      const param = await safe(`component[${ci}].getParam(${pi})`, async () => component.getParam(pi), null);
      if (!param) continue;
      const displayName = param.displayName || null;
      info.params.push({ index: pi, displayName });
      if (
        textParamRef === null &&
        typeof displayName === "string" &&
        /text|テキスト|ソース/i.test(displayName)
      ) {
        textParamRef = { param, component: ci, index: pi, displayName };
      }
    }
    result.components.push(info);
  }

  // Rewrite the text parameter when requested.
  if (typeof params.text === "string" && params.text && textParamRef) {
    result.textParam = {
      component: textParamRef.component,
      index: textParamRef.index,
      displayName: textParamRef.displayName,
    };
    try {
      project.lockedAccess(() => {
        project.executeTransaction((compoundAction) => {
          const keyframe = textParamRef.param.createKeyframe(params.text);
          compoundAction.addAction(textParamRef.param.createSetValueAction(keyframe, true));
        }, "Gospelo bridge: set telop text");
      });
      result.textSet = true;
    } catch (error) {
      diagnostics.push(`setText: ${String((error && (error.message || error)) || error)}`);
    }
  }

  return result;
}

entrypoints.setup({
  panels: {
    "gospelo-premiere-bridge-panel": {
      create() {
        document.getElementById("connect").addEventListener("click", connect);
        document.getElementById("forget").addEventListener("click", onForget);
        restoreTokenAndConnect();
      },
      show() {
        if (currentToken) connect();
      },
    },
  },
});
