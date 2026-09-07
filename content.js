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
    await shared.updateState((state) => ({
      ...state,
      notes: shared.renumberNotes(state.notes.filter((note) => note.id !== noteId))
    }));
  }

  async function updateNote(noteId, patch) {
    await shared.updateState((state) => {
      const timestamp = new Date().toISOString();

      return {
        ...state,
        notes: shared.renumberNotes(
          state.notes.map((note) =>
            note.id === noteId ? { ...note, ...patch, updatedAt: timestamp } : note
          )
        )
      };
    });
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
      deleteNote(note.id).catch(console.error);
    });

    const editor = document.createElement("div");
    editor.className = "sjf-note-editor";
    editor.contentEditable = "plaintext-only";
    editor.spellcheck = false;
    editor.textContent = note.text;
    editor.setAttribute("aria-label", "付箋の内容");
    editor.setAttribute("role", "textbox");
    editor.setAttribute("aria-multiline", "true");
    editor.addEventListener("blur", () => {
      const nextText = editor.innerText.replace(/\r\n/g, "\n").replace(/\n$/, "");

      if (nextText !== note.text) {
        updateNote(note.id, { text: nextText }).catch(console.error);
      }
    });
    editor.addEventListener("keydown", (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        editor.blur();
      }
    });

    enableDrag(note, card, card);
    card.append(deleteButton, editor);
    return card;
  }

  function render(state) {
    const normalized = shared.normalizeState(state);
    lastRenderedState = normalized;

    if (!mountNode) {
      return;
    }

    mountNode.replaceChildren();

    const notes = normalized.enabled ? normalized.notes.filter((note) => note.visible) : [];

    if (!notes.length) {
      mountNode.hidden = true;
      return;
    }

    mountNode.hidden = false;

    const overlay = document.createElement("section");
    overlay.className = "sjf-overlay";
    overlay.setAttribute("aria-label", "すごくじゃまなふせん");
    const entries = notes.map((note) => ({
      note,
      card: createStickyNote(note)
    }));

    entries.forEach(({ card }) => {
      overlay.appendChild(card);
    });

    mountNode.appendChild(overlay);

    const layout = createAutoLayoutState();

    entries.forEach(({ note, card }) => {
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
    window.addEventListener("resize", () => {
      if (lastRenderedState) {
        render(lastRenderedState);
      }
    });
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
