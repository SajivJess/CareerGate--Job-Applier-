const DEFAULT_BASE_URL = "http://127.0.0.1:3000";

chrome.runtime.onInstalled.addListener(() => {
  if (chrome.sidePanel?.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  }
});

async function getBaseUrl() {
  try {
    const stored = await chrome.storage.local.get(["careerOpsBaseUrl"]);
    return (stored.careerOpsBaseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
  } catch {
    return DEFAULT_BASE_URL;
  }
}

function bytesToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function apiFetchJson(path, options = {}) {
  const base = await getBaseUrl();
  const res = await fetch(`${base}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  if (!res.ok) {
    const msg = (json && typeof json.error === "string" && json.error) || text || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return json;
}

async function notifyCareerOpsTabs() {
  try {
    const tabs = await chrome.tabs.query({
      url: ["http://127.0.0.1:3000/*", "http://localhost:3000/*"],
    });
    for (const tab of tabs) {
      if (!tab.id) continue;
      chrome.scripting
        .executeScript({
          target: { tabId: tab.id },
          func: () => window.dispatchEvent(new CustomEvent("co-job-done")),
        })
        .catch(() => {});
    }
  } catch {
    // Ignore when no local tabs match or permission unavailable
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === "API_GET_CONTEXT") {
        const data = await apiFetchJson("/api/launchpad", { method: "GET" });
        sendResponse({ ok: true, data });
        return;
      }

      if (msg.type === "API_LINKEDIN_PREPARE") {
        const base = await getBaseUrl();
        const res = await fetch(`${base}/api/linkedin-prepare`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(msg.payload || {}),
        });
        const text = await res.text();
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
        if (!res.ok || !json?.ok) {
          sendResponse({
            ok: false,
            needsJd: Boolean(json?.needsJd),
            error: json?.error || text || `HTTP ${res.status}`,
          });
          return;
        }
        void notifyCareerOpsTabs();
        sendResponse({ ok: true, data: json });
        return;
      }

      if (msg.type === "API_SAVE_QA") {
        const data = await apiFetchJson("/api/qa-memory", {
          method: "POST",
          body: JSON.stringify({
            question: msg.question,
            answer: msg.answer,
            fieldType: msg.fieldType || "text",
            alsoRememberFact: Boolean(msg.alsoRememberFact),
          }),
        });
        void notifyCareerOpsTabs();
        sendResponse({ ok: true, data });
        return;
      }

      if (msg.type === "API_DELETE_QA") {
        const key = encodeURIComponent(msg.key || "");
        const data = await apiFetchJson(`/api/qa-memory?key=${key}`, { method: "DELETE" });
        void notifyCareerOpsTabs();
        sendResponse({ ok: true, data });
        return;
      }

      if (msg.type === "API_MARK_STATUS") {
        const data = await apiFetchJson("/api/status", {
          method: "POST",
          body: JSON.stringify(
            msg.undo
              ? { n: String(msg.trackerNum), undo: true }
              : { n: String(msg.trackerNum), status: msg.status },
          ),
        });
        void notifyCareerOpsTabs();
        sendResponse({ ok: true, data });
        return;
      }

      if (msg.type === "API_SEED_FOLLOWUP") {
        const data = await apiFetchJson("/api/followups/seed", {
          method: "POST",
          body: JSON.stringify({ n: String(msg.trackerNum) }),
        });
        void notifyCareerOpsTabs();
        sendResponse({ ok: true, data });
        return;
      }

      if (msg.type === "API_FETCH_PDF") {
        const base = await getBaseUrl();
        const kindParam = msg.kind === "cover" ? "&kind=cover" : "";
        const res = await fetch(`${base}/api/cv-pdf?n=${encodeURIComponent(msg.num)}${kindParam}`);
        if (!res.ok) {
          throw new Error(`PDF fetch failed (${res.status}) for report #${msg.num}`);
        }
        const buf = await res.arrayBuffer();
        const filename =
          msg.kind === "cover"
            ? `Sajiv-Jess-B-I-Cover-Letter-${msg.numStr || msg.num}.pdf`
            : `Sajiv-Jess-B-I-Resume-${msg.numStr || msg.num}.pdf`;
        sendResponse({
          ok: true,
          base64: bytesToBase64(buf),
          filename,
        });
        return;
      }

      sendResponse({ ok: false, error: `Unknown message type: ${msg.type}` });
    } catch (err) {
      sendResponse({
        ok: false,
        error: err instanceof Error ? err.message : "Extension background error",
      });
    }
  })();
  return true;
});

