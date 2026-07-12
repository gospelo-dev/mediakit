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
      } else if (message.method === "sequence.trimClip") {
        result = await trimClip(params);
      } else if (message.method === "sequence.razorClip") {
        result = await razorClip(params);
      } else if (message.method === "sequence.createSubsequence") {
        result = await createSubsequenceFromItems(params);
      } else if (message.method === "sequence.removeClip") {
        result = await removeClip(params);
      } else if (message.method === "sequence.setClipTransform") {
        result = await setClipTransform(params);
      } else if (message.method === "project.setActiveSequence") {
        result = await setActiveSequence(params);
      } else if (message.method === "project.listSequences") {
        result = await listSequences(params);
      } else if (message.method === "project.createSequence") {
        result = await createSequenceInProject(params);
      } else if (message.method === "project.save") {
        result = await saveProject(params);
      } else if (message.method === "project.renameItem") {
        result = await renameItem(params);
      } else if (message.method === "sequence.addEffect") {
        result = await addEffect(params);
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

  const frameSize = await safe("sequence.getFrameSize", async () => await sequence.getFrameSize(), null);
  const timebaseTicks = await safe("sequence.getTimebase", async () => {
    const timebase = await sequence.getTimebase();
    const n = Number(typeof timebase === "object" && timebase !== null ? timebase.ticks || timebase : timebase);
    return Number.isFinite(n) && n > 0 ? n : null;
  }, null);

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
      frameWidth: frameSize ? frameSize.width : null,
      frameHeight: frameSize ? frameSize.height : null,
      fps: timebaseTicks ? TICKS_PER_SECOND / timebaseTicks : null,
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

// ---- sequence.trimClip (adjust a clip's in/out points) ------------------------
// Premiere's API has no razor, but "cut at T and drop the head/tail" is
// equivalent to trimming the clip edge. createSetInPointAction /
// createSetOutPointAction semantics are undocumented, so the response
// includes the observed before/after (start/end/in/out) — callers judge the
// outcome from the observation, and can follow up with sequence.moveClip.

async function readItemTimes(item, safe) {
  return {
    startSeconds: await safe("getStartTime", async () => tickTimeToSeconds(await item.getStartTime()), null),
    endSeconds: await safe("getEndTime", async () => tickTimeToSeconds(await item.getEndTime()), null),
    inSeconds: await safe("getInPoint", async () => tickTimeToSeconds(await item.getInPoint()), null),
    outSeconds: await safe("getOutPoint", async () => tickTimeToSeconds(await item.getOutPoint()), null),
  };
}

async function trimClip(params) {
  const project = await ppro.Project.getActiveProject();
  if (!project) throw new Error("No active project is open.");
  const sequence = await project.getActiveSequence();
  if (!sequence) throw new Error("No active sequence. Open a sequence in the timeline, then retry.");
  if (params.itemStartSeconds === undefined || params.itemStartSeconds === null) {
    throw new Error("itemStartSeconds is required (identifies the clip to trim).");
  }
  if (
    (params.inSeconds === undefined || params.inSeconds === null) &&
    (params.outSeconds === undefined || params.outSeconds === null) &&
    (params.cutSequenceSeconds === undefined || params.cutSequenceSeconds === null)
  ) {
    throw new Error("Provide inSeconds, outSeconds, and/or cutSequenceSeconds.");
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
  const starts = [];
  for (const item of items) {
    const start = await safe("item.getStartTime", async () => tickTimeToSeconds(await item.getStartTime()), null);
    starts.push(start);
    if (start !== null && Math.abs(start - Number(params.itemStartSeconds)) <= tolerance) {
      target = item;
      break;
    }
  }
  if (!target) {
    throw new Error(
      `No clip starting at ${params.itemStartSeconds}s (tolerance ${tolerance}s) on ${trackType}[${trackIndex}]. ` +
        `Clip starts on that track: ${JSON.stringify(starts)}`,
    );
  }

  const before = await readItemTimes(target, safe);

  // cutSequenceSeconds: callers think in TIMELINE time ("cut at 00:03:03"),
  // so convert to a source in-point here: newIn = in + (cut - start).
  let inSeconds = params.inSeconds;
  if (params.cutSequenceSeconds !== undefined && params.cutSequenceSeconds !== null) {
    if (before.inSeconds === null || before.startSeconds === null) {
      throw new Error("Could not read the clip's current times to convert cutSequenceSeconds.");
    }
    inSeconds = before.inSeconds + (Number(params.cutSequenceSeconds) - before.startSeconds);
  }

  const actions = [];
  if (inSeconds !== undefined && inSeconds !== null) {
    const inTime = await safe(
      "TickTime.createWithSeconds(in)",
      async () => ppro.TickTime.createWithSeconds(Number(inSeconds)),
      null,
    );
    if (inTime) actions.push(() => target.createSetInPointAction(inTime));
  }
  if (params.outSeconds !== undefined && params.outSeconds !== null) {
    const outTime = await safe(
      "TickTime.createWithSeconds(out)",
      async () => ppro.TickTime.createWithSeconds(Number(params.outSeconds)),
      null,
    );
    if (outTime) actions.push(() => target.createSetOutPointAction(outTime));
  }

  const result = {
    trimmed: false,
    name: await safe("item.getName", async () => await target.getName(), null),
    trackType,
    trackIndex,
    before,
    after: null,
    diagnostics,
  };
  if (actions.length === 0) return result;

  result.trimmed = runTransaction(
    project,
    () => actions.map((build) => build()),
    "Gospelo bridge: trim clip",
    diagnostics,
  );
  result.after = await readItemTimes(target, safe);

  // closeGap: a head trim moves the clip's start right (UI trim-left
  // semantics). Move it back in a SECOND transaction based on the OBSERVED
  // shift. (Composing both into one transaction fails with "Invalid
  // parameter": action factories validate against the pre-transaction
  // state, where the move-back would target a negative position.)
  if (
    params.closeGap &&
    result.trimmed &&
    before.startSeconds !== null &&
    result.after &&
    result.after.startSeconds !== null
  ) {
    const shift = result.after.startSeconds - before.startSeconds;
    if (Math.abs(shift) > 1e-9) {
      const backTime = await safe(
        "TickTime.createWithSeconds(back)",
        async () => ppro.TickTime.createWithSeconds(-shift),
        null,
      );
      if (backTime) {
        result.gapClosed = runTransaction(
          project,
          () => target.createMoveAction(backTime),
          "Gospelo bridge: close trim gap",
          diagnostics,
        );
        result.after = await readItemTimes(target, safe);
      }
    } else {
      result.gapClosed = true;
    }
  }
  return result;
}

// ---- sequence.razorClip (split one clip into two at a timeline position) ------
// Premiere's API has no razor. Composite recipe from verified primitives:
// clone the clip onto the SAME track with a time offset in overwrite mode
// (the overwritten half of the original is auto-trimmed away), then edge-trim
// the clone and move it into place. Two mirror strategies exist; the clone
// overhangs the original by the length of the piece being created, so we
// auto-pick the feasible strategy with the SHORTER overhang and require its
// hazard zone to be empty. Every step is observed; on an unexpected
// intermediate state we stop immediately (one undo from safety).

async function listOtherItems(track, target, safe) {
  const items = (await safe("getTrackItems(zone)", async () => await getTrackItems(track), [])) || [];
  const out = [];
  for (const item of items) {
    if (item === target) continue;
    const times = await readItemTimes(item, safe);
    if (times.startSeconds !== null && times.endSeconds !== null) out.push(times);
  }
  return out;
}

function zoneIsFree(others, zoneStart, zoneEnd) {
  const eps = 1e-6;
  return others.every((it) => it.endSeconds <= zoneStart + eps || it.startSeconds >= zoneEnd - eps);
}

async function findItemByTimes(track, wantStart, wantEnd, tolerance, safe) {
  const items = (await safe("getTrackItems(find)", async () => await getTrackItems(track), [])) || [];
  for (const item of items) {
    const start = await safe("find.getStartTime", async () => tickTimeToSeconds(await item.getStartTime()), null);
    const end = await safe("find.getEndTime", async () => tickTimeToSeconds(await item.getEndTime()), null);
    if (
      start !== null &&
      end !== null &&
      Math.abs(start - wantStart) <= tolerance &&
      Math.abs(end - wantEnd) <= tolerance
    ) {
      return item;
    }
  }
  return null;
}

async function razorClip(params) {
  const project = await ppro.Project.getActiveProject();
  if (!project) throw new Error("No active project is open.");
  const sequence = await project.getActiveSequence();
  if (!sequence) throw new Error("No active sequence. Open a sequence in the timeline, then retry.");
  if (params.cutSequenceSeconds === undefined || params.cutSequenceSeconds === null) {
    throw new Error("cutSequenceSeconds is required.");
  }
  if (params.itemStartSeconds === undefined || params.itemStartSeconds === null) {
    throw new Error("itemStartSeconds is required (identifies the clip to split).");
  }

  const diagnostics = [];
  const safe = makeSafe(diagnostics);
  const trackType = params.trackType === "audio" ? "audio" : "video";
  const trackIndex = Number(params.trackIndex || 0);
  const tolerance = params.toleranceSeconds !== undefined ? Number(params.toleranceSeconds) : 0.05;
  const cut = Number(params.cutSequenceSeconds);

  const track = await safe(
    `${trackType}Track(${trackIndex})`,
    async () =>
      trackType === "video" ? await sequence.getVideoTrack(trackIndex) : await sequence.getAudioTrack(trackIndex),
    null,
  );
  if (!track) throw new Error(`Track not found: ${trackType}[${trackIndex}]`);

  const items = (await safe("getTrackItems", async () => await getTrackItems(track), [])) || [];
  let target = null;
  const starts = [];
  for (const item of items) {
    const start = await safe("item.getStartTime", async () => tickTimeToSeconds(await item.getStartTime()), null);
    starts.push(start);
    if (start !== null && Math.abs(start - Number(params.itemStartSeconds)) <= tolerance) {
      target = item;
      break;
    }
  }
  if (!target) {
    throw new Error(
      `No clip starting at ${params.itemStartSeconds}s (tolerance ${tolerance}s) on ${trackType}[${trackIndex}]. ` +
        `Clip starts on that track: ${JSON.stringify(starts)}`,
    );
  }

  const before = await readItemTimes(target, safe);
  if (before.startSeconds === null || before.endSeconds === null || before.inSeconds === null) {
    throw new Error("Could not read the clip's current times.");
  }
  const S = before.startSeconds;
  const E = before.endSeconds;
  const I = before.inSeconds;
  if (!(S + 1e-6 < cut && cut < E - 1e-6)) {
    throw new Error(`cutSequenceSeconds (${cut}) must be strictly inside the clip [${S}..${E}].`);
  }
  const headLen = cut - S; // Δ
  const tailLen = E - cut; // Γ

  // Strategy feasibility: the clone overhangs by the created piece's length.
  const others = await listOtherItems(track, target, safe);
  const canCloneTail = zoneIsFree(others, E, E + headLen); // overhang after the clip
  const canCloneHead = S - tailLen >= -1e-9 && zoneIsFree(others, S - tailLen, S); // overhang before
  let strategy = null;
  if (canCloneTail && canCloneHead) strategy = headLen <= tailLen ? "clone-tail" : "clone-head";
  else if (canCloneTail) strategy = "clone-tail";
  else if (canCloneHead) strategy = "clone-head";
  else {
    throw new Error(
      `No feasible razor strategy: need ${headLen}s free after ${E}s or ${tailLen}s free before ${S}s ` +
        `(and non-negative timeline). Other clips: ${JSON.stringify(others)}`,
    );
  }

  const editor = await safe("SequenceEditor.getEditor", async () => ppro.SequenceEditor.getEditor(sequence), null);
  if (!editor) throw new Error("SequenceEditor unavailable (see diagnostics).");
  const isVideo = trackType === "video";

  const result = {
    split: false,
    strategy,
    before,
    original: null,
    clone: null,
    diagnostics,
  };

  const offset = strategy === "clone-tail" ? headLen : -tailLen;
  const offsetTime = await safe(
    "TickTime.createWithSeconds(cloneOffset)",
    async () => ppro.TickTime.createWithSeconds(offset),
    null,
  );
  if (!offsetTime) return result;

  // Step 1: clone in place with the offset (overwrite trims the original).
  const cloned = runTransaction(
    project,
    () => editor.createCloneTrackItemAction(target, offsetTime, 0, 0, isVideo, false),
    "Gospelo bridge: razor step 1 (clone)",
    diagnostics,
  );
  if (!cloned) return result;

  // Observe: the original must now be exactly one piece.
  const originalAfterClone = await readItemTimes(target, safe);
  const expectOriginal =
    strategy === "clone-tail"
      ? { start: S, end: cut } // tail overwritten away
      : { start: cut, end: E }; // head overwritten away
  if (
    originalAfterClone.startSeconds === null ||
    Math.abs(originalAfterClone.startSeconds - expectOriginal.start) > tolerance ||
    Math.abs(originalAfterClone.endSeconds - expectOriginal.end) > tolerance
  ) {
    result.original = originalAfterClone;
    diagnostics.push(
      `razor aborted after step 1: original observed ${JSON.stringify(originalAfterClone)}, ` +
        `expected ~${JSON.stringify(expectOriginal)}. One undo reverts the clone.`,
    );
    return result;
  }

  // Locate the clone by its expected placement.
  const cloneWant =
    strategy === "clone-tail"
      ? { start: cut, end: E + headLen }
      : { start: S - tailLen, end: cut };
  const clone = await findItemByTimes(track, cloneWant.start, cloneWant.end, Math.max(tolerance, 0.1), safe);
  if (!clone) {
    diagnostics.push(
      `razor aborted after step 1: clone not found at ~${JSON.stringify(cloneWant)}. One undo reverts.`,
    );
    result.original = originalAfterClone;
    return result;
  }

  // Step 2: edge-trim the clone to the piece's content.
  const trimPoint = I + headLen; // source position of the cut
  const trimTime = await safe(
    "TickTime.createWithSeconds(trim)",
    async () => ppro.TickTime.createWithSeconds(trimPoint),
    null,
  );
  if (!trimTime) return result;
  const trimmed = runTransaction(
    project,
    () =>
      strategy === "clone-tail"
        ? clone.createSetInPointAction(trimTime) // left-trim: becomes the tail content
        : clone.createSetOutPointAction(trimTime), // right-trim: becomes the head content
    "Gospelo bridge: razor step 2 (trim clone)",
    diagnostics,
  );
  if (!trimmed) {
    result.original = originalAfterClone;
    result.clone = await readItemTimes(clone, safe);
    return result;
  }

  // Step 3: move the clone into its final place.
  const moveBack = strategy === "clone-tail" ? -headLen : tailLen;
  const moveTime = await safe(
    "TickTime.createWithSeconds(moveBack)",
    async () => ppro.TickTime.createWithSeconds(moveBack),
    null,
  );
  if (!moveTime) return result;
  const moved = runTransaction(
    project,
    () => clone.createMoveAction(moveTime),
    "Gospelo bridge: razor step 3 (place clone)",
    diagnostics,
  );

  result.original = await readItemTimes(target, safe);
  result.clone = await readItemTimes(clone, safe);
  result.split =
    moved &&
    result.original.startSeconds !== null &&
    result.clone.startSeconds !== null &&
    Math.abs(
      Math.min(result.original.startSeconds, result.clone.startSeconds) - S,
    ) <= tolerance &&
    Math.abs(Math.max(result.original.endSeconds, result.clone.endSeconds) - E) <= tolerance;
  return result;
}

// ---- PIP kit: createSubsequence / removeClip / setClipTransform ---------------

async function findTrackItem(sequence, trackType, trackIndex, itemStartSeconds, tolerance, safe) {
  const track = await safe(
    `${trackType}Track(${trackIndex})`,
    async () =>
      trackType === "video" ? await sequence.getVideoTrack(trackIndex) : await sequence.getAudioTrack(trackIndex),
    null,
  );
  if (!track) throw new Error(`Track not found: ${trackType}[${trackIndex}]`);
  const items = (await safe("getTrackItems", async () => await getTrackItems(track), [])) || [];
  const starts = [];
  for (const item of items) {
    const start = await safe("item.getStartTime", async () => tickTimeToSeconds(await item.getStartTime()), null);
    starts.push(start);
    if (start !== null && Math.abs(start - Number(itemStartSeconds)) <= tolerance) return item;
  }
  throw new Error(
    `No clip starting at ${itemStartSeconds}s (tolerance ${tolerance}s) on ${trackType}[${trackIndex}]. ` +
      `Clip starts: ${JSON.stringify(starts)}`,
  );
}

// Create a child (nested) sequence from the given track items. The originals
// stay on the timeline (combine with sequence.removeClip + sequence.insertClip
// of the returned project item to complete a nest-in-place).
async function createSubsequenceFromItems(params) {
  const project = await ppro.Project.getActiveProject();
  if (!project) throw new Error("No active project is open.");
  const sequence = await project.getActiveSequence();
  if (!sequence) throw new Error("No active sequence. Open a sequence in the timeline, then retry.");
  if (!Array.isArray(params.items) || params.items.length === 0) {
    throw new Error("items (array of {trackType, trackIndex, itemStartSeconds}) is required.");
  }

  const diagnostics = [];
  const safe = makeSafe(diagnostics);
  const tolerance = params.toleranceSeconds !== undefined ? Number(params.toleranceSeconds) : 0.05;

  const beforeIds = (await safe("listRootItemIds(before)", async () => await listRootItemIds(project), [])) || [];

  await safe("clearSelection", async () => await sequence.clearSelection(), null);
  const selection = await safe("getSelection", async () => await sequence.getSelection(), null);
  if (!selection) throw new Error("Could not obtain a selection object (see diagnostics).");
  for (const spec of params.items) {
    const item = await findTrackItem(
      sequence,
      spec.trackType === "audio" ? "audio" : "video",
      Number(spec.trackIndex || 0),
      Number(spec.itemStartSeconds || 0),
      tolerance,
      safe,
    );
    await safe("selection.addItem", async () => selection.addItem(item), null);
  }
  const selectionApplied = await safe("setSelection", async () => sequence.setSelection(selection), null);

  const newSequence = await safe(
    "createSubsequence",
    async () => await sequence.createSubsequence(params.ignoreTrackTargeting !== false),
    null,
  );

  const afterIds = (await safe("listRootItemIds(after)", async () => await listRootItemIds(project), [])) || [];
  const newIds = afterIds.filter((id) => !beforeIds.includes(id));
  const result = {
    created: Boolean(newSequence),
    selectionApplied,
    newSequenceName: newSequence ? await safe("newSequence.name", async () => newSequence.name, null) : null,
    newItemIds: newIds,
    diagnostics,
  };
  if (params.debug && newSequence) {
    result._reflect = { newSequence: reflectMethods(newSequence) };
  }
  return result;
}

// Remove one clip from the timeline (no ripple by default).
async function removeClip(params) {
  const project = await ppro.Project.getActiveProject();
  if (!project) throw new Error("No active project is open.");
  const sequence = await project.getActiveSequence();
  if (!sequence) throw new Error("No active sequence. Open a sequence in the timeline, then retry.");
  if (params.itemStartSeconds === undefined || params.itemStartSeconds === null) {
    throw new Error("itemStartSeconds is required.");
  }

  const diagnostics = [];
  const safe = makeSafe(diagnostics);
  const trackType = params.trackType === "audio" ? "audio" : "video";
  const trackIndex = Number(params.trackIndex || 0);
  const tolerance = params.toleranceSeconds !== undefined ? Number(params.toleranceSeconds) : 0.05;

  const target = await findTrackItem(sequence, trackType, trackIndex, params.itemStartSeconds, tolerance, safe);
  const before = await readItemTimes(target, safe);
  const name = await safe("item.getName", async () => await target.getName(), null);

  await safe("clearSelection", async () => await sequence.clearSelection(), null);
  const selection = await safe("getSelection", async () => await sequence.getSelection(), null);
  if (!selection) throw new Error("Could not obtain a selection object (see diagnostics).");
  await safe("selection.addItem", async () => selection.addItem(target), null);

  const editor = await safe("SequenceEditor.getEditor", async () => ppro.SequenceEditor.getEditor(sequence), null);
  const mediaType =
    ppro.Constants && ppro.Constants.MediaType
      ? trackType === "video"
        ? ppro.Constants.MediaType.VIDEO
        : ppro.Constants.MediaType.AUDIO
      : null;
  const removed = editor
    ? runTransaction(
        project,
        () => editor.createRemoveItemsAction(selection, Boolean(params.ripple), mediaType, false),
        "Gospelo bridge: remove clip",
        diagnostics,
      )
    : false;
  return { removed, name, before, trackType, trackIndex, diagnostics };
}

// Set a clip's Motion transform (position in sequence pixels, scale in %).
// Reads the current values first so callers can calibrate units.
async function setClipTransform(params) {
  const project = await ppro.Project.getActiveProject();
  if (!project) throw new Error("No active project is open.");
  const sequence = await project.getActiveSequence();
  if (!sequence) throw new Error("No active sequence. Open a sequence in the timeline, then retry.");
  if (params.itemStartSeconds === undefined || params.itemStartSeconds === null) {
    throw new Error("itemStartSeconds is required.");
  }

  const diagnostics = [];
  const safe = makeSafe(diagnostics);
  const trackType = params.trackType === "audio" ? "audio" : "video";
  const trackIndex = Number(params.trackIndex || 0);
  const tolerance = params.toleranceSeconds !== undefined ? Number(params.toleranceSeconds) : 0.05;

  const target = await findTrackItem(sequence, trackType, trackIndex, params.itemStartSeconds, tolerance, safe);
  const chain = await safe("getComponentChain", async () => await target.getComponentChain(), null);
  if (!chain) throw new Error("Could not read the clip's component chain (see diagnostics).");

  // Locate the Motion fixed effect by matchName (locale-independent).
  let motion = null;
  const count = (await safe("getComponentCount", async () => chain.getComponentCount(), 0)) || 0;
  for (let i = 0; i < count; i++) {
    const component = await safe(`getComponentAtIndex(${i})`, async () => chain.getComponentAtIndex(i), null);
    if (!component) continue;
    const matchName = await safe(`component[${i}].getMatchName`, async () => await component.getMatchName(), null);
    if (matchName === "AE.ADBE Motion") {
      motion = component;
      break;
    }
  }
  if (!motion) throw new Error("Motion component (AE.ADBE Motion) not found on the clip.");

  const positionParam = await safe("getParam(0)", async () => motion.getParam(0), null); // 位置 / Position
  const scaleParam = await safe("getParam(1)", async () => motion.getParam(1), null); // スケール / Scale

  async function readParamValue(param, label) {
    return await safe(`${label}.getStartValue`, async () => {
      const keyframe = await param.getStartValue();
      const value = keyframe && keyframe.value !== undefined ? keyframe.value : keyframe;
      if (value && typeof value === "object" && "x" in value && "y" in value) return { x: value.x, y: value.y };
      if (value && typeof value === "object" && "value" in value) return value.value;
      return value;
    }, null);
  }

  const result = {
    applied: false,
    name: await safe("item.getName", async () => await target.getName(), null),
    positionBefore: positionParam ? await readParamValue(positionParam, "position") : null,
    scaleBefore: scaleParam ? await readParamValue(scaleParam, "scale") : null,
    positionAfter: null,
    scaleAfter: null,
    diagnostics,
  };

  const wantScale = params.scale !== undefined && params.scale !== null;
  const wantPosition =
    params.positionX !== undefined && params.positionX !== null && params.positionY !== undefined && params.positionY !== null;
  if (!wantScale && !wantPosition) return result; // read-only call

  result.applied = runTransaction(
    project,
    () => {
      const actions = [];
      if (wantScale && scaleParam) {
        actions.push(scaleParam.createSetValueAction(scaleParam.createKeyframe(Number(params.scale)), true));
      }
      if (wantPosition && positionParam) {
        const point = new ppro.PointF(Number(params.positionX), Number(params.positionY));
        actions.push(positionParam.createSetValueAction(positionParam.createKeyframe(point), true));
      }
      return actions;
    },
    "Gospelo bridge: set clip transform",
    diagnostics,
  );

  result.positionAfter = positionParam ? await readParamValue(positionParam, "positionAfter") : null;
  result.scaleAfter = scaleParam ? await readParamValue(scaleParam, "scaleAfter") : null;
  return result;
}

// ---- project.setActiveSequence (switch which sequence is active) --------------
// Needed for nested-sequence workflows: tools operate on the ACTIVE sequence,
// so fixing anything inside a nest means activating it first (and switching
// back afterwards). Sequences are addressed by name; a miss lists what exists.

async function setActiveSequence(params) {
  const project = await ppro.Project.getActiveProject();
  if (!project) throw new Error("No active project is open.");
  if (!params.name || typeof params.name !== "string") {
    throw new Error("name (sequence name) is required.");
  }

  const diagnostics = [];
  const safe = makeSafe(diagnostics);

  const sequences = (await safe("getSequences", async () => await project.getSequences(), [])) || [];
  const names = [];
  let target = null;
  for (const sequence of sequences) {
    const name = await safe("sequence.name", async () => sequence.name, null);
    names.push(name);
    if (name === params.name) target = sequence;
  }
  if (!target) {
    throw new Error(`Sequence not found: ${JSON.stringify(params.name)}. Available: ${JSON.stringify(names)}`);
  }

  const activated = await safe("setActiveSequence", async () => await project.setActiveSequence(target), null);
  const active = await safe("getActiveSequence", async () => await project.getActiveSequence(), null);
  const activeName = active ? await safe("active.name", async () => active.name, null) : null;
  return {
    activated: Boolean(activated) || activeName === params.name,
    activeSequenceName: activeName,
    availableSequences: names,
    diagnostics,
  };
}

// Read one component-param value via its start keyframe (shared helper).
// Native Color/PointF wrappers have non-enumerable properties (JSON shows
// {}), so extract channels via explicit property access.
async function readComponentParamValue(param, label, safe) {
  return await safe(`${label}.getStartValue`, async () => {
    const keyframe = await param.getStartValue();
    let value = keyframe && keyframe.value !== undefined ? keyframe.value : keyframe;
    if (value && typeof value === "object" && "value" in value) value = value.value;
    if (value && typeof value === "object") {
      if (typeof value.red === "number" || typeof value.blue === "number") {
        return { red: value.red, green: value.green, blue: value.blue, alpha: value.alpha, _type: "color" };
      }
      if (typeof value.x === "number" && typeof value.y === "number") return { x: value.x, y: value.y };
    }
    return value;
  }, null);
}

// ---- project.createSequence (new sequence in the EXISTING project) ------------
// createSequenceFromMedia adopts the first clip's format (frame size / fps)
// and places the given clips; without items this method errors (an empty
// preset-based sequence would need a preset path - not exposed yet).

async function createSequenceInProject(params) {
  const project = await ppro.Project.getActiveProject();
  if (!project) throw new Error("No active project is open.");
  if (!params.name || typeof params.name !== "string") {
    throw new Error("name is required.");
  }
  if (!Array.isArray(params.itemIds) || params.itemIds.length === 0) {
    throw new Error("itemIds (project item IDs from project.assets.list) is required.");
  }

  const diagnostics = [];
  const safe = makeSafe(diagnostics);

  const clips = [];
  for (const id of params.itemIds) {
    const item = await safe(`findProjectItemById(${id})`, async () => await findProjectItemById(project, id), null);
    if (!item) throw new Error(`Project item not found: ${id}`);
    clips.push(ppro.ClipProjectItem.cast(item));
  }

  const sequence = await safe(
    "createSequenceFromMedia",
    async () => await project.createSequenceFromMedia(params.name, clips),
    null,
  );
  const result = {
    created: Boolean(sequence),
    name: sequence ? await safe("sequence.name", async () => sequence.name, null) : null,
    diagnostics,
  };
  if (sequence) {
    const frameSize = await safe("getFrameSize", async () => await sequence.getFrameSize(), null);
    result.frameWidth = frameSize ? frameSize.width : null;
    result.frameHeight = frameSize ? frameSize.height : null;
  }
  return result;
}

// ---- project.save --------------------------------------------------------------

async function saveProject(params) {
  const project = await ppro.Project.getActiveProject();
  if (!project) throw new Error("No active project is open.");
  const diagnostics = [];
  const safe = makeSafe(diagnostics);
  const saved = await safe("project.save", async () => await project.save(), null);
  return {
    saved: saved !== null ? Boolean(saved) || saved === undefined : false,
    path: await safe("project.path", async () => project.path, null),
    diagnostics,
  };
}

// ---- sequence.addEffect (append a video filter and optionally set a colour) ---
// Roadmap stage 4 via the OFFICIAL VideoFilterFactory (not the unofficial QE
// DOM): the effect is resolved from the live getDisplayNames()/getMatchNames()
// inventory, appended in a transaction, and its parameters are read back.
// Colour parameters are detected structurally (value object with red/green/
// blue) and set with automatic range calibration (0-255 vs 0-1: set, read
// back, retry in the other scale on mismatch).

async function addEffect(params) {
  const project = await ppro.Project.getActiveProject();
  if (!project) throw new Error("No active project is open.");
  const sequence = await project.getActiveSequence();
  if (!sequence) throw new Error("No active sequence. Open a sequence in the timeline, then retry.");
  if (params.itemStartSeconds === undefined || params.itemStartSeconds === null) {
    throw new Error("itemStartSeconds is required.");
  }
  if (!params.matchName && !params.effectQuery) {
    throw new Error("Provide matchName or effectQuery (display-name substring).");
  }

  const diagnostics = [];
  const safe = makeSafe(diagnostics);
  const trackType = params.trackType === "audio" ? "audio" : "video";
  const trackIndex = Number(params.trackIndex || 0);
  const tolerance = params.toleranceSeconds !== undefined ? Number(params.toleranceSeconds) : 0.05;

  const target = await findTrackItem(sequence, trackType, trackIndex, params.itemStartSeconds, tolerance, safe);

  // Resolve the effect matchName from the live filter inventory.
  let matchName = params.matchName || null;
  let displayName = null;
  if (!matchName) {
    const matchNames = (await safe("factory.getMatchNames", async () => await ppro.VideoFilterFactory.getMatchNames(), [])) || [];
    const displayNames =
      (await safe("factory.getDisplayNames", async () => await ppro.VideoFilterFactory.getDisplayNames(), [])) || [];
    const query = String(params.effectQuery).toLowerCase();
    const hits = [];
    for (let i = 0; i < displayNames.length; i++) {
      if (String(displayNames[i]).toLowerCase().includes(query)) hits.push(i);
    }
    if (hits.length === 0) {
      throw new Error(`No video filter display name contains ${JSON.stringify(params.effectQuery)} (of ${displayNames.length}).`);
    }
    matchName = matchNames[hits[0]];
    displayName = displayNames[hits[0]];
    if (hits.length > 1) {
      diagnostics.push(
        `effectQuery matched ${hits.length} filters; using the first. Candidates: ` +
          JSON.stringify(hits.map((i) => displayNames[i])),
      );
    }
  }

  const chain = await safe("getComponentChain", async () => await target.getComponentChain(), null);
  if (!chain) throw new Error("Could not read the clip's component chain.");

  const result = {
    applied: false,
    matchName,
    displayName,
    clipName: await safe("item.getName", async () => await target.getName(), null),
    params: [],
    colorSet: null,
    diagnostics,
  };

  let applied = null;
  if (params.existing) {
    // Inspect / re-configure an effect ALREADY on the clip (no re-append).
    const count = (await safe("componentCount", async () => chain.getComponentCount(), 0)) || 0;
    for (let i = 0; i < count; i++) {
      const candidate = await safe(`component(${i})`, async () => chain.getComponentAtIndex(i), null);
      if (!candidate) continue;
      const candidateMatch = await safe(`component(${i}).matchName`, async () => await candidate.getMatchName(), null);
      if (candidateMatch === matchName) {
        applied = candidate;
        break;
      }
    }
    if (!applied) throw new Error(`Effect ${matchName} is not on the clip.`);
    result.applied = true;
  } else {
    const component = await safe(
      "VideoFilterFactory.createComponent",
      async () => await ppro.VideoFilterFactory.createComponent(matchName),
      null,
    );
    if (!component) throw new Error(`Could not create filter component: ${matchName}`);
    const countBefore = (await safe("componentCount(before)", async () => chain.getComponentCount(), 0)) || 0;
    const appended = runTransaction(
      project,
      () => chain.createAppendComponentAction(component),
      "Gospelo bridge: add effect",
      diagnostics,
    );
    if (!appended) return result;
    const countAfter = (await safe("componentCount(after)", async () => chain.getComponentCount(), 0)) || 0;
    result.applied = countAfter === countBefore + 1;
    applied = await safe("getComponentAtIndex(new)", async () => chain.getComponentAtIndex(countAfter - 1), null);
    if (!applied) return result;
  }

  // Inventory the new effect's params (and find colour params structurally).
  const paramCount = (await safe("effect.paramCount", async () => applied.getParamCount(), 0)) || 0;
  let colorParam = null;
  let colorParamIndex = null;
  for (let i = 0; i < paramCount; i++) {
    const param = await safe(`effect.getParam(${i})`, async () => applied.getParam(i), null);
    if (!param) continue;
    const value = await readComponentParamValue(param, `effectParam${i}`, safe);
    result.params.push({ index: i, displayName: param.displayName || null, value });
    const isColor =
      value !== null &&
      typeof value === "object" &&
      ("red" in value || "r" in value) &&
      ("blue" in value || "b" in value);
    if (colorParam === null && isColor) {
      colorParam = param;
      colorParamIndex = i;
    }
  }

  // Optional: set a colour parameter from a hex string with range calibration.
  if (params.colorHex && colorParam) {
    const hex = String(params.colorHex).replace(/^#/, "");
    const r255 = parseInt(hex.slice(0, 2), 16);
    const g255 = parseInt(hex.slice(2, 4), 16);
    const b255 = parseInt(hex.slice(4, 6), 16);
    const attempts = [
      { scale: "0-255", r: r255, g: g255, b: b255 },
      { scale: "0-1", r: r255 / 255, g: g255 / 255, b: b255 / 255 },
    ];
    for (const attempt of attempts) {
      const ok = runTransaction(
        project,
        () =>
          colorParam.createSetValueAction(
            colorParam.createKeyframe(new ppro.Color(attempt.r, attempt.g, attempt.b, 1)),
            true,
          ),
        "Gospelo bridge: set effect color",
        diagnostics,
      );
      const readback = ok ? await readComponentParamValue(colorParam, "colorReadback", safe) : null;
      // Normalize the read-back channels to 0-255 and compare against the
      // requested hex; the BLUE channel is the strongest signal here.
      let matches = false;
      if (readback && readback._type === "color") {
        const maxChannel = Math.max(readback.red || 0, readback.green || 0, readback.blue || 0);
        const scale = maxChannel <= 1.001 ? 255 : 1;
        matches =
          Math.abs((readback.red || 0) * scale - r255) <= 3 &&
          Math.abs((readback.green || 0) * scale - g255) <= 3 &&
          Math.abs((readback.blue || 0) * scale - b255) <= 3;
      }
      result.colorSet = { paramIndex: colorParamIndex, scaleTried: attempt.scale, readback, accepted: matches };
      if (matches) break;
    }
  } else if (params.colorHex && !colorParam) {
    diagnostics.push("colorHex given but no colour-typed parameter was detected on the effect.");
  }
  return result;
}

// ---- project.renameItem (rename a bin item; sequences share this name) --------

async function renameItem(params) {
  const project = await ppro.Project.getActiveProject();
  if (!project) throw new Error("No active project is open.");
  if (!params.itemId || typeof params.itemId !== "string") {
    throw new Error("itemId is required (from project.assets.list).");
  }
  if (!params.newName || typeof params.newName !== "string") {
    throw new Error("newName is required.");
  }

  const diagnostics = [];
  const safe = makeSafe(diagnostics);

  const item = await safe("findProjectItemById", async () => await findProjectItemById(project, params.itemId), null);
  if (!item) throw new Error(`Project item not found: ${params.itemId}`);
  const projectItem = ppro.ProjectItem.cast(item);
  const before = await safe("item.name(before)", async () => projectItem.name, null);

  const renamed = runTransaction(
    project,
    () => projectItem.createSetNameAction(params.newName),
    "Gospelo bridge: rename item",
    diagnostics,
  );
  const after = await safe("item.name(after)", async () => projectItem.name, null);
  return { renamed: renamed && after === params.newName, nameBefore: before, nameAfter: after, diagnostics };
}

// ---- project.listSequences (frame size / fps of ALL sequences) ----------------
// Enumerates every sequence in the project - parents and nested children
// alike - without switching the active sequence, and reads each one's frame
// size, fps and track counts directly.

async function listSequences(params) {
  const project = await ppro.Project.getActiveProject();
  if (!project) throw new Error("No active project is open.");

  const diagnostics = [];
  const safe = makeSafe(diagnostics);

  const active = await safe("getActiveSequence", async () => await project.getActiveSequence(), null);
  const activeName = active ? await safe("active.name", async () => active.name, null) : null;

  const sequences = (await safe("getSequences", async () => await project.getSequences(), [])) || [];
  const out = [];
  for (const sequence of sequences) {
    const name = await safe("sequence.name", async () => sequence.name, null);
    const frameSize = await safe(`getFrameSize(${name})`, async () => await sequence.getFrameSize(), null);
    const timebaseTicks = await safe(`getTimebase(${name})`, async () => {
      const timebase = await sequence.getTimebase();
      const n = Number(typeof timebase === "object" && timebase !== null ? timebase.ticks || timebase : timebase);
      return Number.isFinite(n) && n > 0 ? n : null;
    }, null);
    const entry = {
      name,
      isActive: name !== null && name === activeName,
      frameWidth: frameSize ? frameSize.width : null,
      frameHeight: frameSize ? frameSize.height : null,
      fps: timebaseTicks ? TICKS_PER_SECOND / timebaseTicks : null,
      videoTrackCount: await safe(`videoCount(${name})`, async () => await sequence.getVideoTrackCount(), null),
      audioTrackCount: await safe(`audioCount(${name})`, async () => await sequence.getAudioTrackCount(), null),
    };

    // Optionally include each video clip's Motion scale (horizontal/vertical)
    // so scaling relationships across parents and nests are visible at once.
    if (params.includeClipTransforms) {
      entry.clips = [];
      const vCount = entry.videoTrackCount || 0;
      for (let ti = 0; ti < vCount; ti++) {
        const track = await safe(`getVideoTrack(${name},${ti})`, async () => await sequence.getVideoTrack(ti), null);
        if (!track) continue;
        const items = (await safe(`getTrackItems(${name},${ti})`, async () => await getTrackItems(track), [])) || [];
        for (const item of items) {
          const clip = {
            track: ti,
            name: await safe("clip.getName", async () => await item.getName(), null),
            startSeconds: await safe("clip.getStartTime", async () => tickTimeToSeconds(await item.getStartTime()), null),
            endSeconds: await safe("clip.getEndTime", async () => tickTimeToSeconds(await item.getEndTime()), null),
            mediaPath: await safe(
              "clip.mediaPath",
              async () => {
                const projectItem = await item.getProjectItem();
                if (!projectItem) return null;
                return await ppro.ClipProjectItem.cast(projectItem).getMediaFilePath();
              },
              null,
            ),
            position: null,
            scale: null,
            scaleWidth: null,
            uniformScale: null,
          };
          const chain = await safe("clip.getComponentChain", async () => await item.getComponentChain(), null);
          if (chain) {
            const componentCount = (await safe("clip.componentCount", async () => chain.getComponentCount(), 0)) || 0;
            for (let ci = 0; ci < componentCount; ci++) {
              const component = await safe(`clip.component(${ci})`, async () => chain.getComponentAtIndex(ci), null);
              if (!component) continue;
              const matchName = await safe("clip.matchName", async () => await component.getMatchName(), null);
              if (matchName !== "AE.ADBE Motion") continue;
              // Motion params (observed): 0 = Position (normalized 0..1),
              // 1 = Scale, 2 = Scale Width, 3 = uniform-scale toggle.
              const positionParam = await safe("positionParam", async () => component.getParam(0), null);
              const scaleParam = await safe("scaleParam", async () => component.getParam(1), null);
              const widthParam = await safe("widthParam", async () => component.getParam(2), null);
              const uniformParam = await safe("uniformParam", async () => component.getParam(3), null);
              if (positionParam) clip.position = await readComponentParamValue(positionParam, "position", safe);
              if (scaleParam) clip.scale = await readComponentParamValue(scaleParam, "scale", safe);
              if (widthParam) clip.scaleWidth = await readComponentParamValue(widthParam, "scaleWidth", safe);
              if (uniformParam) clip.uniformScale = await readComponentParamValue(uniformParam, "uniform", safe);
              break;
            }
          }
          entry.clips.push(clip);
        }
      }
    }
    out.push(entry);
  }
  return { activeSequenceName: activeName, sequences: out, diagnostics };
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
