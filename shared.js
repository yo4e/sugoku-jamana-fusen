(function attachShared(global) {
  "use strict";

  const STORAGE_KEY = "sugoku_jamana_fusen_state";
  const SCHEMA_VERSION = 1;
  const DEFAULT_COLOR_ID = "yellow";
  const DEFAULT_SIZE_ID = "medium";
  const DEFAULT_OPACITY = 0.9;

  const COLOR_PRESETS = [
    { id: "yellow", label: "蛍光イエロー", hex: "#fff16a" },
    { id: "pink", label: "蛍光ピンク", hex: "#ff8ed0" },
    { id: "green", label: "蛍光グリーン", hex: "#b8ff75" },
    { id: "orange", label: "オレンジ", hex: "#ffb14a" },
    { id: "blue", label: "水色", hex: "#8ddcff" },
    { id: "white", label: "白", hex: "#fffdf7" }
  ];

  const SIZE_PRESETS = [
    { id: "small", label: "小" },
    { id: "medium", label: "中" },
    { id: "large", label: "大" }
  ];

  function createId() {
    if (global.crypto && typeof global.crypto.randomUUID === "function") {
      return global.crypto.randomUUID();
    }

    return "note-" + Date.now() + "-" + Math.random().toString(16).slice(2);
  }

  function nowIsoString() {
    return new Date().toISOString();
  }

  function isKnownColor(colorId) {
    return COLOR_PRESETS.some((preset) => preset.id === colorId);
  }

  function isKnownSize(sizeId) {
    return SIZE_PRESETS.some((preset) => preset.id === sizeId);
  }

  function clampOpacity(value) {
    const number = Number(value);

    if (!Number.isFinite(number)) {
      return DEFAULT_OPACITY;
    }

    const bounded = Math.min(1, Math.max(0.4, number));
    return Math.round(bounded * 100) / 100;
  }

  function clampAlpha(value) {
    const number = Number(value);

    if (!Number.isFinite(number)) {
      return 1;
    }

    return Math.min(1, Math.max(0, number));
  }

  function normalizePosition(rawPosition) {
    if (!rawPosition || typeof rawPosition !== "object") {
      return null;
    }

    const x = Number(rawPosition.x);
    const y = Number(rawPosition.y);

    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return null;
    }

    return {
      x: Math.round(x),
      y: Math.round(y)
    };
  }

  function normalizeNote(rawNote, index) {
    const fallbackTimestamp = nowIsoString();
    const note = rawNote && typeof rawNote === "object" ? rawNote : {};

    return {
      id: typeof note.id === "string" && note.id ? note.id : createId(),
      text: typeof note.text === "string" ? note.text : "",
      color: isKnownColor(note.color) ? note.color : DEFAULT_COLOR_ID,
      size: isKnownSize(note.size) ? note.size : DEFAULT_SIZE_ID,
      opacity: clampOpacity(note.opacity),
      position: normalizePosition(note.position),
      visible: note.visible !== false,
      createdAt:
        typeof note.createdAt === "string" && note.createdAt
          ? note.createdAt
          : fallbackTimestamp,
      updatedAt:
        typeof note.updatedAt === "string" && note.updatedAt
          ? note.updatedAt
          : fallbackTimestamp,
      order: Number.isInteger(note.order) ? note.order : index
    };
  }

  function normalizeState(rawState) {
    const state = rawState && typeof rawState === "object" ? rawState : {};
    const rawNotes = Array.isArray(state.notes) ? state.notes : [];

    const notes = rawNotes
      .map((note, index) => normalizeNote(note, index))
      .sort((left, right) => {
        if (left.order !== right.order) {
          return left.order - right.order;
        }

        return left.createdAt.localeCompare(right.createdAt);
      })
      .map((note, index) => ({ ...note, order: index }));

    return {
      schemaVersion: SCHEMA_VERSION,
      enabled: state.enabled !== false,
      notes
    };
  }

  async function loadState() {
    if (!global.chrome || !chrome.storage || !chrome.storage.local) {
      return normalizeState();
    }

    const stored = await chrome.storage.local.get(STORAGE_KEY);
    return normalizeState(stored[STORAGE_KEY]);
  }

  async function saveState(nextState) {
    const normalized = normalizeState(nextState);

    if (!global.chrome || !chrome.storage || !chrome.storage.local) {
      return normalized;
    }

    await chrome.storage.local.set({ [STORAGE_KEY]: normalized });
    return normalized;
  }

  async function updateState(updater) {
    const current = await loadState();
    const nextState = typeof updater === "function" ? updater(current) : updater;
    return saveState(nextState);
  }

  function createNote(overrides) {
    const timestamp = nowIsoString();

    return normalizeNote(
      {
        id: createId(),
        text: "",
        color: DEFAULT_COLOR_ID,
        size: DEFAULT_SIZE_ID,
        opacity: DEFAULT_OPACITY,
        position: null,
        visible: true,
        createdAt: timestamp,
        updatedAt: timestamp,
        ...(overrides || {})
      },
      0
    );
  }

  function renumberNotes(notes) {
    return notes.map((note, index) => ({ ...note, order: index }));
  }

  function findColorPreset(colorId) {
    return COLOR_PRESETS.find((preset) => preset.id === colorId) || COLOR_PRESETS[0];
  }

  function parseHex(hex) {
    const value = hex.replace("#", "");
    return {
      r: parseInt(value.slice(0, 2), 16),
      g: parseInt(value.slice(2, 4), 16),
      b: parseInt(value.slice(4, 6), 16)
    };
  }

  function hexToRgba(hex, alpha) {
    const rgb = parseHex(hex);
    return "rgba(" + rgb.r + ", " + rgb.g + ", " + rgb.b + ", " + clampAlpha(alpha) + ")";
  }

  function darkenHex(hex, amount) {
    const rgb = parseHex(hex);
    const ratio = Math.min(1, Math.max(0, Number(amount) || 0));

    const darkenChannel = (channel) => Math.max(0, Math.round(channel * (1 - ratio)));

    const toHex = (channel) => darkenChannel(channel).toString(16).padStart(2, "0");

    return "#" + toHex(rgb.r) + toHex(rgb.g) + toHex(rgb.b);
  }

  function getNoteTheme(note) {
    const preset = findColorPreset(note.color);

    return {
      background: hexToRgba(preset.hex, note.opacity),
      border: darkenHex(preset.hex, 0.32),
      shadow: hexToRgba(darkenHex(preset.hex, 0.42), 0.22),
      button: hexToRgba(darkenHex(preset.hex, 0.62), 0.14)
    };
  }

  function formatOpacity(opacity) {
    return Math.round(clampOpacity(opacity) * 100) + "%";
  }

  global.SugokuJamanaFusenShared = {
    STORAGE_KEY,
    SCHEMA_VERSION,
    COLOR_PRESETS,
    SIZE_PRESETS,
    DEFAULT_COLOR_ID,
    DEFAULT_SIZE_ID,
    DEFAULT_OPACITY,
    clampOpacity,
    createNote,
    findColorPreset,
    formatOpacity,
    getNoteTheme,
    loadState,
    normalizePosition,
    normalizeNote,
    normalizeState,
    renumberNotes,
    saveState,
    updateState
  };
})(globalThis);
