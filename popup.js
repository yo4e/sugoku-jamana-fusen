(function initPopup() {
  "use strict";

  const shared = globalThis.SugokuJamanaFusenShared;

  if (!shared) {
    return;
  }

  let refs;

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

  async function deleteNote(noteId) {
    await shared.updateState((state) => ({
      ...state,
      notes: shared.renumberNotes(state.notes.filter((note) => note.id !== noteId))
    }));
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

    await shared.updateState((state) => ({
      ...state,
      notes: shared.renumberNotes([...state.notes, note])
    }));

    refs.newNoteText.value = "";
    refs.newNoteColor.value = shared.DEFAULT_COLOR_ID;
    refs.newNoteSize.value = shared.DEFAULT_SIZE_ID;
    refs.newNoteOpacity.value = String(shared.DEFAULT_OPACITY * 100);
    updateComposerOpacityLabel();
    refs.newNoteText.focus();
  }

  function createNoteEditor(note, index) {
    const card = document.createElement("article");
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
      deleteNote(note.id).catch(console.error);
    });

    actionGroup.append(resetPositionButton, deleteButton);
    header.append(titleWrap, actionGroup);

    const textarea = document.createElement("textarea");
    textarea.className = "sjf-note-textarea";
    textarea.rows = 4;
    textarea.value = note.text;
    textarea.placeholder = "未処理を書いておく";
    textarea.addEventListener("blur", () => {
      const nextText = textarea.value.replace(/\r\n/g, "\n");
      if (nextText !== note.text) {
        updateNote(note.id, { text: nextText }).catch(console.error);
      }
    });
    textarea.addEventListener("keydown", (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        textarea.blur();
      }
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

    card.append(header, textarea, controls, secondaryRow);
    return card;
  }

  function render(state) {
    const normalized = shared.normalizeState(state);
    refs.enabledToggle.checked = normalized.enabled;
    refs.noteCount.textContent = normalized.notes.length + "枚";
    refs.emptyState.hidden = normalized.notes.length > 0;
    refs.noteList.replaceChildren();

    normalized.notes.forEach((note, index) => {
      refs.noteList.appendChild(createNoteEditor(note, index));
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
        .updateState((state) => ({ ...state, enabled: refs.enabledToggle.checked }))
        .catch(console.error);
    });

    chrome.storage.onChanged.addListener(handleStorageChange);
    render(await shared.loadState());
  }

  document.addEventListener("DOMContentLoaded", () => {
    initialize().catch(console.error);
  });
})();
