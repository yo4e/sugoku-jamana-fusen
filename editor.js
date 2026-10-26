(function attachEditor(global) {
  "use strict";
  const shared = global.SugokuJamanaFusenShared;

  // The element and mutable note identity survive storage updates, including
  // a move to a recovery note. Shared by the page overlay and popup.
  function bind(element, note, status, onSaved) {
    // Native textarea values preserve empty text and intentional trailing
    // newlines without contenteditable's browser-generated DIV/BR placeholders.
    const read = () => element.value.replace(/\r\n/g, "\n");
    const write = (text) => { element.value = text; };
    let baseText = note.text;
    let composing = false;
    let pending = null;
    let timer;
    let disposed = false;
    let failedEdit = null;

    function showStatus(error) {
      status.textContent = error
        ? "保存できませんでした。入力欄を選び直すと再試行します。文章はこの欄に残っています。"
        : note.recoveredFrom
          ? (note.recoveredFrom.reason === "deleted" ? "削除された付箋の編集中の文章を保護しました" : "同時編集した文章を別の付箋として保護しました")
          : "";
      status.hidden = !status.textContent;
    }

    function schedule(delay = 350) {
      clearTimeout(timer);
      if (!disposed && !composing) timer = setTimeout(flush, delay);
    }

    function flush() {
      clearTimeout(timer);
      if (disposed || composing || pending) return pending;
      if (!failedEdit && read() === baseText) return Promise.resolve();
      // Retry the same request first. New input is saved after acknowledgement.
      const edit = failedEdit || {
        kind: "text", noteId: note.id, baseText, text: read(),
        fallback: { ...note }, editId: shared.createId()
      };
      let succeeded = false;
      pending = shared.mutate(edit).then((saved) => {
        if (disposed) return;
        const previousId = note.id;
        baseText = edit.text;
        Object.assign(note, saved);
        failedEdit = null;
        succeeded = true;
        showStatus();
        onSaved(previousId, note);
      }).catch(() => {
        failedEdit = edit;
        showStatus(true);
      }).finally(() => {
        pending = null;
        if (!disposed && succeeded && read() !== baseText) schedule(0);
      });
      return pending;
    }

    element.addEventListener("input", () => schedule());
    element.addEventListener("blur", flush);
    element.addEventListener("focus", () => { if (failedEdit) flush(); });
    element.addEventListener("compositionstart", () => { composing = true; clearTimeout(timer); });
    element.addEventListener("compositionend", () => { composing = false; schedule(0); });
    element.addEventListener("keydown", (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && !event.isComposing && !composing) {
        event.preventDefault();
        element.blur();
        flush();
      }
    });
    showStatus();

    return {
      flush,
      hasDraft: () => !disposed && (composing || !!pending || !!failedEdit || read() !== baseText),
      sync(next) {
        const dirty = composing || pending || failedEdit || read() !== baseText;
        Object.assign(note, next);
        if (!dirty) {
          baseText = next.text;
          if (read() !== next.text) write(next.text);
          showStatus();
        } else if (!pending && !failedEdit && next.text !== baseText) {
          flush();
        }
      },
      dispose() { disposed = true; clearTimeout(timer); },
      resume() { disposed = false; schedule(0); }
    };
  }

  global.SugokuJamanaFusenEditor = { bind };
})(globalThis);
