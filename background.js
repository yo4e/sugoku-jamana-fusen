"use strict";

importScripts("shared.js");
const shared = globalThis.SugokuJamanaFusenShared;
// Serialize the entire read/check/write operation for every app writer.
let mutations = Promise.resolve();

async function applyMutation(action) {
  const state = await shared.loadState();
  const current = state.notes.find((note) => note.id === action.noteId);
  let result;

  switch (action.kind) {
    case "add":
      result = shared.createNote(action.note);
      state.notes.push(result);
      break;
    case "delete":
      state.notes = state.notes.filter((note) => note.id !== action.noteId);
      break;
    case "enabled":
      state.enabled = action.enabled !== false;
      break;
    case "patch":
      if (!current) return;
      // Text must go through the conflict check below.
      for (const field of ["color", "size", "opacity", "position", "visible"]) {
        if (Object.prototype.hasOwnProperty.call(action.patch || {}, field)) {
          current[field] = action.patch[field];
        }
      }
      current.updatedAt = new Date().toISOString();
      result = current;
      break;
    case "text": {
      if (typeof action.text !== "string" || typeof action.baseText !== "string" ||
          typeof action.editId !== "string" || !action.editId) {
        throw new Error("Invalid text edit");
      }
      // Retrying after a lost response must not duplicate a recovery note.
      const previous = state.notes.find((note) => note.lastTextEditId === action.editId);
      if (previous) return previous;
      if (current && current.text === action.text) return current;

      if (current && current.text === action.baseText) {
        current.text = action.text;
        current.updatedAt = new Date().toISOString();
        current.lastTextEditId = action.editId;
        result = current;
      } else {
        // Leave the stored version intact; preserve the draft as an ordinary
        // editable note. Recover a draft deleted by another tab the same way.
        result = shared.createNote({
          ...(current || action.fallback),
          id: shared.createId(), text: action.text, position: null, visible: true,
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
          recoveredFrom: { noteId: action.noteId, reason: current ? "conflict" : "deleted" },
          lastTextEditId: action.editId
        });
        state.notes.push(result);
      }
      break;
    }
    default:
      throw new Error("Unknown note mutation");
  }

  state.notes = shared.renumberNotes(state.notes);
  const saved = await shared.saveState(state);
  return result && saved.notes.find((note) => note.id === result.id);
}

function isSupportedUrl(url) {
  return typeof url === "string" && /^(https?:)\/\//.test(url);
}

async function injectIntoTab(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId }, files: ["shared.js", "editor.js", "content.js"]
    });
  } catch (error) {
    console.warn("Could not inject sticky note scripts into tab", tabId, error);
  }
}

async function injectIntoEligibleTabs() {
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.filter((tab) => Number.isInteger(tab.id) && isSupportedUrl(tab.url))
    .map((tab) => injectIntoTab(tab.id)));
}

chrome.runtime.onInstalled.addListener(() => injectIntoEligibleTabs().catch(console.error));
chrome.runtime.onStartup.addListener(() => injectIntoEligibleTabs().catch(console.error));
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" && isSupportedUrl(tab.url)) injectIntoTab(tabId).catch(console.error);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || !["mutate-notes", "persist-note-position"].includes(message.type)) return false;
  const action = message.type === "persist-note-position"
    ? { kind: "patch", noteId: message.noteId, patch: { position: message.position } }
    : message.action;
  const operation = mutations.then(() => applyMutation(action));
  mutations = operation.catch(() => {});
  operation.then((note) => sendResponse({ ok: true, note }), (error) => {
    console.error(error);
    sendResponse({ ok: false, error: String(error) });
  });
  return true;
});
