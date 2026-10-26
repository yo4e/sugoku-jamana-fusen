(function initPopup() {
  "use strict";

  const shared = globalThis.SugokuJamanaFusenShared;

  if (!shared) {
    return;
  }

  let refs;
  const cards = new Map();

  function buildOption(option) {
    const element = document.createElement("option");
    element.value = option.id;
    element.textContent = option.label;
    return element;
  }

  function applyTheme(element, note) {
    const theme = shared.getNoteTheme(note);
    element.style.setProperty("--sjf-note-bg", theme.background);
    element.style.setProperty("--sjf-note-border", theme.border);
    element.style.setProperty("--sjf-note-shadow", theme.shadow);
    element.style.setProperty("--sjf-note-button", theme.button);
  }

  function createColorSelect(selectedColor) {
    const select = document.createElement("select");
    shared.COLOR_PRESETS.forEach((preset) => select.appendChild(buildOption(preset)));
    select.value = selectedColor;
    return select;
  }

  function createSizeSelect(selectedSize) {
    const select = document.createElement("select");
    shared.SIZE_PRESETS.forEach((preset) => select.appendChild(buildOption(preset)));
    select.value = selectedSize;
    return select;
  }

  function updateComposerOpacityLabel() {
    refs.newNoteOpacityValue.textContent = refs.newNoteOpacity.value + "%";
  }

  async function updateNote(noteId, patch) {
    await shared.mutate({ kind: "patch", noteId, patch });
  }

  async function deleteNote(noteId) {
    await shared.mutate({ kind: "delete", noteId });
  }

  async function addNote() {
    const text = refs.newNoteText.value.trim();

    if (!text) {
      refs.newNoteText.focus();
      return;
    }

    const note = shared.createNote({
      text: refs.newNoteText.value.replace(/\r\n/g, "\n"),
      color: refs.newNoteColor.value,
      size: refs.newNoteSize.value,
      opacity: Number(refs.newNoteOpacity.value) / 100
    });

    await shared.mutate({ kind: "add", note });

    refs.newNoteText.value = "";
    refs.newNoteColor.value = shared.DEFAULT_COLOR_ID;
    refs.newNoteSize.value = shared.DEFAULT_SIZE_ID;
    refs.newNoteOpacity.value = String(shared.DEFAULT_OPACITY * 100);
    updateComposerOpacityLabel();
    refs.newNoteText.focus();
  }

  function createNoteEditor(note, index) {
    const card = document.createElement("article");
    const entry = { note, card };
    card.className = "sjf-popup-note";
    applyTheme(card, note);

    const header = document.createElement("div");
    header.className = "sjf-note-editor-header";

    const titleWrap = document.createElement("div");

    const title = document.createElement("h3");
    title.textContent = "付箋 " + (index + 1);

    const meta = document.createElement("p");
    meta.className = "sjf-note-editor-meta";
    meta.textContent = "表示中 " + shared.formatOpacity(note.opacity) + " / ページ上でドラッグ可";

    titleWrap.append(title, meta);

    const actionGroup = document.createElement("div");
    actionGroup.className = "sjf-note-editor-actions";

    const resetPositionButton = document.createElement("button");
    resetPositionButton.className = "sjf-delete-button";
    resetPositionButton.type = "button";
    resetPositionButton.textContent = "位置戻す";
    resetPositionButton.addEventListener("click", () => {
      updateNote(note.id, { position: null }).catch(console.error);
    });

    const deleteButton = document.createElement("button");
    deleteButton.className = "sjf-delete-button";
    deleteButton.type = "button";
    deleteButton.textContent = "削除";
    deleteButton.addEventListener("click", () => {
      entry.draft.dispose();
      deleteNote(note.id).catch((error) => { entry.draft.resume(); console.error(error); });
    });

    actionGroup.append(resetPositionButton, deleteButton);
    header.append(titleWrap, actionGroup);

    const textarea = document.createElement("textarea");
    textarea.className = "sjf-note-textarea";
    textarea.rows = 4;
    textarea.value = note.text;
    textarea.placeholder = "未処理を書いておく";
    const status = document.createElement("p");
    status.className = "sjf-save-status";
    status.setAttribute("role", "status");
    entry.draft = globalThis.SugokuJamanaFusenEditor.bind(textarea, note, status, (previousId) => {
      const duplicate = cards.get(note.id);
      if (duplicate && duplicate !== entry) {
        duplicate.draft.dispose();
        duplicate.card.remove();
      }
      cards.delete(previousId);
      cards.set(note.id, entry);
      shared.loadState().then((state) => {
        render(state);
        if (previousId !== note.id && document.activeElement === textarea) {
          textarea.scrollIntoView({ block: "nearest" });
        }
      }).catch(console.error);
    });

    const controls = document.createElement("div");
    controls.className = "sjf-control-grid";

    const colorField = document.createElement("label");
    colorField.className = "sjf-field";
    const colorLabel = document.createElement("span");
    colorLabel.textContent = "色";
    const colorSelect = createColorSelect(note.color);
    colorSelect.addEventListener("change", () => {
      updateNote(note.id, { color: colorSelect.value }).catch(console.error);
    });
    colorField.append(colorLabel, colorSelect);

    const sizeField = document.createElement("label");
    sizeField.className = "sjf-field";
    const sizeLabel = document.createElement("span");
    sizeLabel.textContent = "サイズ";
    const sizeSelect = createSizeSelect(note.size);
    sizeSelect.addEventListener("change", () => {
      updateNote(note.id, { size: sizeSelect.value }).catch(console.error);
    });
    sizeField.append(sizeLabel, sizeSelect);

    controls.append(colorField, sizeField);

    const secondaryRow = document.createElement("div");
    secondaryRow.className = "sjf-control-row";

    const opacityField = document.createElement("label");
    opacityField.className = "sjf-field sjf-range-field";
    const opacityLabel = document.createElement("span");
    opacityLabel.textContent = "透明度";
    const opacityWrap = document.createElement("div");
    opacityWrap.className = "sjf-range-wrap";
    const opacityRange = document.createElement("input");
    opacityRange.type = "range";
    opacityRange.min = "40";
    opacityRange.max = "100";
    opacityRange.step = "5";
    opacityRange.value = String(Math.round(note.opacity * 100));
    const opacityValue = document.createElement("strong");
    opacityValue.textContent = shared.formatOpacity(note.opacity);
    opacityRange.addEventListener("input", () => {
      opacityValue.textContent = opacityRange.value + "%";
    });
    opacityRange.addEventListener("change", () => {
      updateNote(note.id, { opacity: Number(opacityRange.value) / 100 }).catch(console.error);
    });
    opacityWrap.append(opacityRange, opacityValue);
    opacityField.append(opacityLabel, opacityWrap);

    const visibleField = document.createElement("label");
    visibleField.className = "sjf-visibility-toggle";
    const visibleCheckbox = document.createElement("input");
    visibleCheckbox.type = "checkbox";
    visibleCheckbox.checked = note.visible;
    visibleCheckbox.addEventListener("change", () => {
      updateNote(note.id, { visible: visibleCheckbox.checked }).catch(console.error);
    });
    const visibleText = document.createElement("span");
    visibleText.textContent = "表示する";
    visibleField.append(visibleCheckbox, visibleText);

    secondaryRow.append(opacityField, visibleField);

    entry.sync = (next, nextIndex) => {
      entry.draft.sync(next);
      title.textContent = "付箋 " + (nextIndex + 1);
      meta.textContent = (next.visible ? "表示中 " : "非表示 ") + shared.formatOpacity(next.opacity) + " / ページ上でドラッグ可";
      colorSelect.value = next.color;
      sizeSelect.value = next.size;
      // Do not interrupt an active slider gesture when another tab saves.
      if (document.activeElement !== opacityRange) opacityRange.value = String(Math.round(next.opacity * 100));
      opacityValue.textContent = opacityRange.value + "%";
      visibleCheckbox.checked = next.visible;
      card.dataset.noteId = note.id;
      card.style.order = String(nextIndex);
      applyTheme(card, next);
    };
    card.append(header, textarea, status, controls, secondaryRow);
    return entry;
  }

  function render(state) {
    const normalized = shared.normalizeState(state);
    refs.enabledToggle.checked = normalized.enabled;
    refs.noteCount.textContent = normalized.notes.length + "枚";
    refs.emptyState.hidden = normalized.notes.length > 0;
    const ids = new Set(normalized.notes.map((note) => note.id));
    for (const [id, entry] of cards) {
      if (!ids.has(id)) {
        if (entry.draft.hasDraft()) entry.draft.flush();
        else {
          entry.draft.dispose();
          entry.card.remove();
          cards.delete(id);
        }
      }
    }
    normalized.notes.forEach((note, index) => {
      let entry = cards.get(note.id);
      if (!entry) {
        entry = createNoteEditor({ ...note }, index);
        cards.set(note.id, entry);
        refs.noteList.appendChild(entry.card);
      }
      entry.sync(note, index);
    });
  }

  function handleStorageChange(changes, areaName) {
    if (areaName !== "local" || !changes[shared.STORAGE_KEY]) {
      return;
    }

    render(changes[shared.STORAGE_KEY].newValue);
  }

  function cacheRefs() {
    refs = {
      addNoteButton: document.getElementById("addNoteButton"),
      emptyState: document.getElementById("emptyState"),
      enabledToggle: document.getElementById("enabledToggle"),
      newNoteColor: document.getElementById("newNoteColor"),
      newNoteOpacity: document.getElementById("newNoteOpacity"),
      newNoteOpacityValue: document.getElementById("newNoteOpacityValue"),
      newNoteSize: document.getElementById("newNoteSize"),
      newNoteText: document.getElementById("newNoteText"),
      noteCount: document.getElementById("noteCount"),
      noteList: document.getElementById("noteList")
    };
  }

  async function initialize() {
    cacheRefs();

    shared.COLOR_PRESETS.forEach((preset) => {
      refs.newNoteColor.appendChild(buildOption(preset));
    });
    refs.newNoteColor.value = shared.DEFAULT_COLOR_ID;

    shared.SIZE_PRESETS.forEach((preset) => {
      refs.newNoteSize.appendChild(buildOption(preset));
    });
    refs.newNoteSize.value = shared.DEFAULT_SIZE_ID;

    refs.newNoteOpacity.value = String(shared.DEFAULT_OPACITY * 100);
    updateComposerOpacityLabel();

    refs.newNoteOpacity.addEventListener("input", updateComposerOpacityLabel);
    refs.addNoteButton.addEventListener("click", () => {
      addNote().catch(console.error);
    });
    refs.newNoteText.addEventListener("keydown", (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        addNote().catch(console.error);
      }
    });
    refs.enabledToggle.addEventListener("change", () => {
      shared
        .mutate({ kind: "enabled", enabled: refs.enabledToggle.checked })
        .catch(console.error);
    });

    chrome.storage.onChanged.addListener(handleStorageChange);
    render(await shared.loadState());
  }

  document.addEventListener("DOMContentLoaded", () => {
    initialize().catch(console.error);
  });
})();
