(function initContentScript() {
  "use strict";

  if (globalThis.__SJF_CONTENT_SCRIPT_INITIALIZED__) {
    return;
  }

  globalThis.__SJF_CONTENT_SCRIPT_INITIALIZED__ = true;

  const shared = globalThis.SugokuJamanaFusenShared;
  const HOST_ID = "sjf-extension-host";
  const VIEWPORT_MARGIN = 14;
  const STACK_GAP = 12;
  let host;
  let mountNode;
  let lastRenderedState = null;
  let overlay;
  const cards = new Map();

  if (!shared) {
    return;
  }

  function applyTheme(element, note) {
    const theme = shared.getNoteTheme(note);
    element.style.setProperty("--sjf-note-bg", theme.background);
    element.style.setProperty("--sjf-note-border", theme.border);
    element.style.setProperty("--sjf-note-shadow", theme.shadow);
    element.style.setProperty("--sjf-note-button", theme.button);
  }

  async function deleteNote(noteId) {
    await shared.mutate({ kind: "delete", noteId });
  }

  async function updateNote(noteId, patch) {
    await shared.mutate({ kind: "patch", noteId, patch });
  }

  async function updateNotePosition(noteId, position) {
    try {
      const response = await chrome.runtime.sendMessage({
        type: "persist-note-position",
        noteId,
        position
      });

      if (response && response.ok) {
        return;
      }
    } catch (error) {
      console.warn("Falling back to direct position persistence", error);
    }

    await updateNote(noteId, { position });
  }

  function clampPositionToViewport(x, y, width, height) {
    const maxX = Math.max(VIEWPORT_MARGIN, window.innerWidth - width - VIEWPORT_MARGIN);
    const maxY = Math.max(VIEWPORT_MARGIN, window.innerHeight - height - VIEWPORT_MARGIN);

    return {
      x: Math.round(Math.min(maxX, Math.max(VIEWPORT_MARGIN, x))),
      y: Math.round(Math.min(maxY, Math.max(VIEWPORT_MARGIN, y)))
    };
  }

  function applyCardPosition(card, position) {
    card.style.left = position.x + "px";
    card.style.top = position.y + "px";
  }

  function createAutoLayoutState() {
    return {
      columnWidth: 0,
      x: null,
      y: VIEWPORT_MARGIN
    };
  }

  function nextAutoPosition(layout, card) {
    const rect = card.getBoundingClientRect();
    const viewportBottom = window.innerHeight - VIEWPORT_MARGIN;

    if (layout.x === null) {
      layout.x = window.innerWidth - rect.width - VIEWPORT_MARGIN;
      layout.columnWidth = rect.width;
    }

    const willOverflowBottom = layout.y + rect.height > viewportBottom;
    const nextColumnX = layout.x - layout.columnWidth - STACK_GAP;
    const canStartNextColumn = nextColumnX >= VIEWPORT_MARGIN;

    if (willOverflowBottom && canStartNextColumn) {
      layout.x = nextColumnX;
      layout.y = VIEWPORT_MARGIN;
      layout.columnWidth = rect.width;
    } else {
      layout.columnWidth = Math.max(layout.columnWidth, rect.width);
    }

    const position = clampPositionToViewport(layout.x, layout.y, rect.width, rect.height);
    layout.y = position.y + rect.height + STACK_GAP;
    return position;
  }

  function enableDrag(note, card, handle) {
    handle.title = "ドラッグで移動";

    handle.addEventListener("pointerdown", (event) => {
      const target =
        event.target instanceof Element ? event.target : event.target && event.target.parentElement;

      if (event.button !== 0 && event.pointerType !== "touch" && event.pointerType !== "pen") {
        return;
      }

      if (target && target.closest(".sjf-note-delete, .sjf-note-editor")) {
        return;
      }

      event.preventDefault();

      const rect = card.getBoundingClientRect();
      const offsetX = event.clientX - rect.left;
      const offsetY = event.clientY - rect.top;
      let latestPosition = clampPositionToViewport(rect.left, rect.top, rect.width, rect.height);

      const move = (moveEvent) => {
        latestPosition = clampPositionToViewport(
          moveEvent.clientX - offsetX,
          moveEvent.clientY - offsetY,
          rect.width,
          rect.height
        );
        applyCardPosition(card, latestPosition);
      };

      const finish = () => {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", finish);
        handle.removeEventListener("pointercancel", cancel);
        card.classList.remove("sjf-dragging");

        if (handle.hasPointerCapture(event.pointerId)) {
          handle.releasePointerCapture(event.pointerId);
        }

        updateNotePosition(note.id, latestPosition).catch(console.error);
      };

      const cancel = () => {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", finish);
        handle.removeEventListener("pointercancel", cancel);
        card.classList.remove("sjf-dragging");

        if (handle.hasPointerCapture(event.pointerId)) {
          handle.releasePointerCapture(event.pointerId);
        }

        render(lastRenderedState);
      };

      card.classList.add("sjf-dragging");
      handle.setPointerCapture(event.pointerId);
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", finish);
      handle.addEventListener("pointercancel", cancel);
    });
  }

  function createStickyNote(note) {
    const card = document.createElement("article");
    const entry = { note, card };
    card.className = "sjf-note sjf-size-" + note.size;
    applyTheme(card, note);

    const deleteButton = document.createElement("button");
    deleteButton.className = "sjf-note-delete";
    deleteButton.type = "button";
    deleteButton.setAttribute("aria-label", "付箋を削除");
    deleteButton.textContent = "×";
    deleteButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      entry.draft.dispose();
      deleteNote(note.id).catch((error) => { entry.draft.resume(); console.error(error); });
    });

    const editor = document.createElement("textarea");
    editor.className = "sjf-note-editor";
    editor.rows = 1;
    editor.spellcheck = false;
    editor.value = note.text;
    editor.setAttribute("aria-label", "付箋の内容");
    editor.setAttribute("role", "textbox");
    editor.setAttribute("aria-multiline", "true");
    const status = document.createElement("p");
    status.className = "sjf-save-status";
    status.setAttribute("role", "status");
    entry.draft = globalThis.SugokuJamanaFusenEditor.bind(editor, note, status, (previousId) => {
      const duplicate = cards.get(note.id);
      if (duplicate && duplicate !== entry) {
        duplicate.draft.dispose();
        duplicate.card.remove();
      }
      cards.delete(previousId);
      cards.set(note.id, entry);
      shared.loadState().then(render).catch(console.error);
    });

    enableDrag(note, card, card);
    card.append(deleteButton, editor, status);
    return entry;
  }

  function render(state) {
    const normalized = shared.normalizeState(state);
    lastRenderedState = normalized;

    if (!mountNode) {
      return;
    }

    if (!overlay || !overlay.isConnected) {
      overlay = document.createElement("section");
      overlay.className = "sjf-overlay";
      overlay.setAttribute("aria-label", "すごくじゃまなふせん");
      // One-time mount only: remove an obsolete overlay left by an extension
      // reload. Normal storage/resize updates retain the current editors.
      mountNode.replaceChildren(overlay);
      cards.clear();
    }
    const notes = normalized.enabled ? normalized.notes.filter((note) => note.visible) : [];
    const visibleIds = new Set(notes.map((note) => note.id));
    for (const [id, entry] of cards) {
      if (!visibleIds.has(id)) {
        // Keep unsaved/IME/failed edits visible until they have been protected.
        if (entry.draft.hasDraft()) entry.draft.flush();
        else {
          entry.draft.dispose();
          entry.card.remove();
          cards.delete(id);
        }
      }
    }
    for (const note of notes) {
      let entry = cards.get(note.id);
      if (!entry) {
        entry = createStickyNote({ ...note });
        cards.set(note.id, entry);
        overlay.appendChild(entry.card);
      } else entry.draft.sync(note);
      entry.card.dataset.noteId = entry.note.id;
      entry.card.className = "sjf-note sjf-size-" + note.size +
        (entry.card.classList.contains("sjf-dragging") ? " sjf-dragging" : "");
      applyTheme(entry.card, note);
    }
    mountNode.hidden = cards.size === 0;
    layoutCards();
  }

  function layoutCards() {
    const layout = createAutoLayoutState();
    const order = new Map((lastRenderedState?.notes || []).map((note, index) => [note.id, index]));
    const entries = [...cards.values()].sort((a, b) => (order.get(a.note.id) ?? Infinity) - (order.get(b.note.id) ?? Infinity));
    entries.forEach(({ note, card }) => {
      if (card.classList.contains("sjf-dragging")) return;
      const rect = card.getBoundingClientRect();
      const position = note.position
        ? clampPositionToViewport(note.position.x, note.position.y, rect.width, rect.height)
        : nextAutoPosition(layout, card);

      applyCardPosition(card, position);
    });
  }

  async function ensureMount() {
    if (mountNode && host && host.isConnected) {
      return;
    }

    host = document.getElementById(HOST_ID);

    if (!host) {
      host = document.createElement("div");
      host.id = HOST_ID;
      host.style.all = "initial";
      document.documentElement.appendChild(host);
    }

    if (!host.shadowRoot) {
      const shadow = host.attachShadow({ mode: "open" });
      const stylesheet = document.createElement("link");
      stylesheet.rel = "stylesheet";
      stylesheet.href = chrome.runtime.getURL("styles.css");
      stylesheet.addEventListener("load", layoutCards);
      shadow.appendChild(stylesheet);

      mountNode = document.createElement("div");
      mountNode.className = "sjf-shadow-root";
      shadow.appendChild(mountNode);
      return;
    }

    mountNode = host.shadowRoot.querySelector(".sjf-shadow-root");
  }

  function handleStorageChange(changes, areaName) {
    if (areaName !== "local" || !changes[shared.STORAGE_KEY]) {
      return;
    }

    ensureMount()
      .then(() => render(changes[shared.STORAGE_KEY].newValue))
      .catch(console.error);
  }

  async function initialize() {
    await ensureMount();
    chrome.storage.onChanged.addListener(handleStorageChange);
    window.addEventListener("resize", layoutCards);
    render(await shared.loadState());
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      initialize().catch(console.error);
    });
  } else {
    initialize().catch(console.error);
  }
})();
