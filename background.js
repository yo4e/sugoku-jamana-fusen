"use strict";

const STORAGE_KEY = "sugoku_jamana_fusen_state";
const SCHEMA_VERSION = 1;

function isSupportedUrl(url) {
  return typeof url === "string" && /^(https?:)\/\//.test(url);
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

async function persistNotePosition(noteId, position) {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const state =
    stored[STORAGE_KEY] && typeof stored[STORAGE_KEY] === "object"
      ? stored[STORAGE_KEY]
      : { schemaVersion: SCHEMA_VERSION, enabled: true, notes: [] };

  const notes = Array.isArray(state.notes) ? state.notes : [];
  const timestamp = new Date().toISOString();

  await chrome.storage.local.set({
    [STORAGE_KEY]: {
      ...state,
      notes: notes.map((note) =>
        note && note.id === noteId
          ? { ...note, position: normalizePosition(position), updatedAt: timestamp }
          : note
      )
    }
  });
}

async function injectIntoTab(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["shared.js", "content.js"]
    });
  } catch (error) {
    console.warn("Could not inject sticky note scripts into tab", tabId, error);
  }
}

async function injectIntoEligibleTabs() {
  const tabs = await chrome.tabs.query({});

  await Promise.all(
    tabs
      .filter((tab) => Number.isInteger(tab.id) && isSupportedUrl(tab.url))
      .map((tab) => injectIntoTab(tab.id))
  );
}

chrome.runtime.onInstalled.addListener(() => {
  injectIntoEligibleTabs().catch(console.error);
});

chrome.runtime.onStartup.addListener(() => {
  injectIntoEligibleTabs().catch(console.error);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete" || !isSupportedUrl(tab.url)) {
    return;
  }

  injectIntoTab(tabId).catch(console.error);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== "persist-note-position" || typeof message.noteId !== "string") {
    return false;
  }

  persistNotePosition(message.noteId, message.position)
    .then(() => sendResponse({ ok: true }))
    .catch((error) => {
      console.error(error);
      sendResponse({ ok: false, error: String(error) });
    });

  return true;
});
