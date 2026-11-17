const STATE = {
  ctx: null,
  activeTab: null,
  matchedItem: null,
  linkedinJob: null,
  scannedFields: [],
  filledReport: [],
  draftAnswers: {},
  confirmApplyPending: false,
};

const SUBMITTED_STATES = new Set(["applied", "responded", "assessment", "interview", "offer", "hired"]);

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function bg(msg) {
  return new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve));
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0] || null;
}

async function execInFrame(tabId, frameId, fn, args = []) {
  const results = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [frameId] },
    func: fn,
    args,
  });
  return results?.[0]?.result;
}

async function execInAllFrames(tabId, fn, args = []) {
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: fn,
    args,
  });
  return Array.isArray(results) ? results : [];
}

async function ensureMatcherInjected(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    files: ["matcher.js"],
  });
}

function renderMatchHeader() {
  const tab = STATE.activeTab;
  const ctx = STATE.ctx;
  const card = document.getElementById("matchCard");
  if (!tab || !ctx) {
    card.classList.add("hidden");
    renderLinkedInCard();
    return;
  }

  let matched = CareerOpsMatcher.findMatchedItem(tab.url || "", ctx.items);
  if (!matched && STATE.linkedinJob?.canonicalUrl) {
    matched = CareerOpsMatcher.findMatchedItem(STATE.linkedinJob.canonicalUrl, ctx.items);
  }
  STATE.matchedItem = matched;
  card.classList.remove("hidden", "banner-applied", "banner-warn", "banner-err");

  if (!matched) {
    card.innerHTML = `
      <h1>External / New Posting</h1>
      <div class="muted">Not one of your ${ctx.items.length} tracked Career-Ops roles yet. Profile defaults + <strong>${ctx.qaMemory.entries.length}</strong> saved Q&amp;A memory answers remain active.</div>
    `;
    renderLinkedInCard();
    renderTrackerControls();
    return;
  }

  const st = (matched.trackerStatus || "Evaluated").trim();
  const isApplied = SUBMITTED_STATES.has(st.toLowerCase()) || matched.duplicateElsewhereApplied;
  const sibAppliedCount = ctx.items.filter(
    (x) => x.company === matched.company && x.numStr !== matched.numStr && SUBMITTED_STATES.has((x.trackerStatus || "").toLowerCase()),
  ).length;

  if (isApplied) {
    card.classList.add("banner-applied");
  } else if (sibAppliedCount > 0) {
    card.classList.add("banner-warn");
  }

  const cvPdfFile = (matched.cvPdfRel || "").split("/").pop() || `Sajiv-Jess-B-I-Resume-${matched.numStr}.pdf`;

  card.innerHTML = `
    <div class="row" style="justify-content:space-between;">
      <span class="pill p-blue">#${esc(matched.numStr)} · Tier ${matched.tier}</span>
      <span class="pill p-green">${Number(matched.score).toFixed(1)}/5 · ${esc(matched.ats)}</span>
    </div>
    <h1 style="margin-top:6px;">${esc(matched.company)} — ${esc(matched.title)}</h1>
    <div class="muted">Email: <code>sajiv2580@gmail.com</code></div>
    <div class="muted">Matched CV: <code>#${esc(matched.numStr)} · ${esc(cvPdfFile)}</code></div>
    ${
      isApplied
        ? `<div style="margin-top:6px;font-weight:700;color:#4ade80;">ALREADY APPLIED (${esc(matched.trackerDate || st)}) — DO NOT RE-SUBMIT!</div>`
        : sibAppliedCount > 0
          ? `<div style="margin-top:6px;font-weight:600;">ℹ ${sibAppliedCount} other ${esc(matched.company)} role(s) already applied</div>`
          : ""
    }
  `;
  renderLinkedInCard();
  renderTrackerControls();
}

function renderLinkedInCard() {
  const card = document.getElementById("linkedinCard");
  if (!card) return;
  const li = STATE.linkedinJob;
  if (!li || !li.isLinkedIn || !li.isJobPage) {
    card.classList.add("hidden");
    return;
  }
  card.classList.remove("hidden");

  const modalPill = li.easyApplyOpen
    ? `<span class="pill p-green">Easy Apply Modal Open</span>`
    : li.hasEasyApplyButton
      ? `<span class="pill p-blue">Easy Apply Available</span>`
      : `<span class="pill p-amber">External / LinkedIn Posting</span>`;

  if (STATE.matchedItem) {
    card.innerHTML = `
      <div class="row" style="justify-content:space-between;">
        <h2>LinkedIn Apply Assistant</h2>
        ${modalPill}
      </div>
      <div class="muted">
        ${
          li.easyApplyOpen
            ? `Click <strong>Scan &amp; Autofill Form ⚡</strong> for each Easy Apply step (Contact → Resume → Questions → Review). Click <strong>Submitted ✓</strong> below after you submit.`
            : `Tracked as <strong>#${esc(STATE.matchedItem.numStr)}</strong>. Click <strong>Easy Apply</strong> (or open the company portal) and then click <strong>Scan &amp; Autofill Form ⚡</strong>.`
        }
      </div>
    `;
    return;
  }

  const missingMeta = !li.title || !li.company;
  const needManualJd = !li.jdLoaded;
  card.innerHTML = `
    <div class="row" style="justify-content:space-between;">
      <h2>LinkedIn Job Detected</h2>
      ${modalPill}
    </div>
    <div style="font-weight:600;margin-top:4px;">${esc(li.title || "Select a LinkedIn job listing")}</div>
    <div class="muted">${esc(li.company || "Company unknown")}${li.location ? ` · ${esc(li.location)}` : ""}${li.jobId ? ` · ID ${esc(li.jobId)}` : ""}</div>
    ${
      needManualJd
        ? `<div class="muted banner-warn" style="margin-top:6px;padding:6px;border-radius:6px;">
             Full JD text wasn't visible yet — scroll &ldquo;About the job&rdquo; on LinkedIn &amp; click <strong>Sync</strong>, or paste JD text below:
           </div>
           <textarea id="liManualJd" placeholder="Paste full LinkedIn job description here (required before generating tailored CV)…" style="margin-top:6px;"></textarea>`
        : ""
    }
    <div class="row" style="margin-top:8px;">
      <button id="liPrepareBtn" class="good" type="button" ${missingMeta ? "disabled" : ""}>Prepare Tailored CV, Cover &amp; Track ⚡</button>
    </div>
    <div id="liPrepStatus" class="muted" style="margin-top:5px;"></div>
  `;

  const prepBtn = document.getElementById("liPrepareBtn");
  if (prepBtn) {
    prepBtn.onclick = async () => {
      const manualJdText = document.getElementById("liManualJd")?.value?.trim() || "";
      const statusEl = document.getElementById("liPrepStatus");
      prepBtn.disabled = true;
      prepBtn.textContent = "Generating tailored CV, Cover & Tracker…";
      statusEl.textContent = "Building fact-checked A4/Letter CV + Cover Letter PDFs…";

      const res = await bg({
        type: "API_LINKEDIN_PREPARE",
        payload: {
          url: li.canonicalUrl || STATE.activeTab?.url || "",
          jobId: li.jobId || "",
          title: li.title,
          company: li.company,
          location: li.location || "",
          jdText: li.jdText || "",
          manualJdText,
        },
      });

      if (!res?.ok) {
        prepBtn.disabled = false;
        prepBtn.textContent = "Prepare Tailored CV, Cover & Track ⚡";
        statusEl.textContent = res?.error || "Could not prepare LinkedIn job";
        if (res?.needsJd && !document.getElementById("liManualJd")) {
          li.jdLoaded = false;
          renderLinkedInCard();
        }
        return;
      }

      statusEl.textContent = res.data?.message || "Ready!";
      await loadContext();
    };
  }
}

function renderTrackerControls() {
  const m = STATE.matchedItem;
  const card = document.getElementById("trackerCard");
  if (!m) {
    card.classList.add("hidden");
    return;
  }
  card.classList.remove("hidden");
  const st = (m.trackerStatus || "Evaluated").trim();
  const isApplied = SUBMITTED_STATES.has(st.toLowerCase());

  if (isApplied) {
    card.innerHTML = `
      <h2>Tracker Status: <span class="pill p-green">${esc(st)}</span></h2>
      <div class="row">
        <button id="seedFollowBtn" class="good" type="button">+ Seed Follow-up</button>
        <button id="undoStatusBtn" type="button">Undo Status</button>
      </div>
      <div id="trackerNote" class="muted" style="margin-top:5px;"></div>
    `;
    document.getElementById("seedFollowBtn").onclick = async () => {
      const r = await bg({ type: "API_SEED_FOLLOWUP", trackerNum: m.trackerNum });
      document.getElementById("trackerNote").textContent = r.ok ? "Follow-up seeded ✓" : `Error: ${r.error}`;
    };
    document.getElementById("undoStatusBtn").onclick = async () => {
      const r = await bg({ type: "API_MARK_STATUS", trackerNum: m.trackerNum, undo: true });
      if (r.ok) await loadContext();
      else document.getElementById("trackerNote").textContent = `Error: ${r.error}`;
    };
    return;
  }

  if (STATE.confirmApplyPending) {
    card.innerHTML = `
      <h2>Did you click Submit on the portal?</h2>
      <div class="row">
        <button id="confirmAppliedBtn" class="good" type="button">Yes, Submitted → Applied ✓</button>
        <button id="cancelAppliedBtn" type="button">Not yet</button>
      </div>
      <div id="trackerNote" class="muted" style="margin-top:5px;"></div>
    `;
    document.getElementById("confirmAppliedBtn").onclick = async () => {
      const btn = document.getElementById("confirmAppliedBtn");
      btn.disabled = true;
      btn.textContent = "Saving…";
      const r = await bg({ type: "API_MARK_STATUS", trackerNum: m.trackerNum, status: "Applied" });
      if (r?.ok) {
        STATE.confirmApplyPending = false;
        await loadContext();
      } else {
        btn.disabled = false;
        btn.textContent = "Yes, Submitted → Applied ✓";
        document.getElementById("trackerNote").textContent = `Error updating tracker: ${r?.error || "Request failed"}`;
      }
    };
    document.getElementById("cancelAppliedBtn").onclick = () => {
      STATE.confirmApplyPending = false;
      renderTrackerControls();
    };
    return;
  }

  card.innerHTML = `
    <h2>After you submit on the webpage</h2>
    <div class="row">
      <button id="markAppliedBtn" class="good" type="button">Submitted ✓</button>
      <button id="markSkipBtn" class="danger" type="button">Skip Role</button>
    </div>
    <div id="trackerNote" class="muted" style="margin-top:5px;"></div>
  `;
  document.getElementById("markAppliedBtn").onclick = () => {
    STATE.confirmApplyPending = true;
    renderTrackerControls();
  };
  document.getElementById("markSkipBtn").onclick = async () => {
    const r = await bg({ type: "API_MARK_STATUS", trackerNum: m.trackerNum, status: "SKIP" });
    if (r?.ok) await loadContext();
    else document.getElementById("trackerNote").textContent = `Error: ${r?.error || "Request failed"}`;
  };
}

function renderMemoryPanel() {
  const entries = STATE.ctx?.qaMemory?.entries || [];
  document.getElementById("memCount").textContent = String(entries.length);
  const q = (document.getElementById("memSearch").value || "").trim().toLowerCase();
  const filtered = q
    ? entries.filter((e) => e.question.toLowerCase().includes(q) || e.answer.toLowerCase().includes(q))
    : entries;

  const listEl = document.getElementById("memList");
  if (filtered.length === 0) {
    listEl.innerHTML = `<div class="muted">No saved Q&amp;A answers yet. Answer any new question on a live form via Active Form tab to save it here forever.</div>`;
    return;
  }

  listEl.innerHTML = filtered
    .map(
      (e) => `
      <div class="ask-item">
        <div class="row" style="justify-content:space-between;">
          <span class="ask-label">${esc(e.question)}</span>
          <button class="danger del-mem-btn" data-key="${esc(e.key)}" type="button">Delete</button>
        </div>
        <div class="muted">${esc(e.answer)}</div>
      </div>
    `,
    )
    .join("");

  listEl.querySelectorAll(".del-mem-btn").forEach((btn) => {
    btn.onclick = async () => {
      await bg({ type: "API_DELETE_QA", key: btn.getAttribute("data-key") });
      await loadContext();
    };
  });
}

async function inspectLinkedInTab() {
  STATE.linkedinJob = null;
  const tab = STATE.activeTab;
  if (!tab?.id || !/^https?:\/\/([^/]+\.)?linkedin\.com\//i.test(tab.url || "")) return;
  try {
    await ensureMatcherInjected(tab.id);
    const info = await execInFrame(tab.id, 0, () => window.CareerOpsMatcher?.domExtractLinkedInJob?.());
    if (info && info.isLinkedIn) STATE.linkedinJob = info;
  } catch {
    STATE.linkedinJob = null;
  }
}

async function loadContext() {
  STATE.activeTab = await getActiveTab();
  const card = document.getElementById("connCard");
  const resp = await bg({ type: "API_GET_CONTEXT" });
  if (!resp?.ok) {
    card.classList.remove("hidden");
    card.classList.add("banner-err");
    card.innerHTML = `
      <strong>Career-Ops server unreachable</strong>
      <div class="muted" style="margin-top:4px;">Start it with <code>start-ui-with-extension.bat</code> (sets extension origin permission on port 3000).<br/>Error: ${esc(resp?.error || "Connection failed")}</div>
    `;
    return false;
  }
  STATE.ctx = resp.data;
  card.classList.add("hidden");
  await inspectLinkedInTab();
  renderMatchHeader();
  renderMemoryPanel();
  return true;
}

function renderAskAndFilled(askFields) {
  const askCard = document.getElementById("askCard");
  const askList = document.getElementById("askList");
  const filledCard = document.getElementById("filledCard");
  const filledList = document.getElementById("filledList");

  document.getElementById("filledCount").textContent = String(STATE.filledReport.length);
  if (STATE.filledReport.length > 0) {
    filledCard.classList.remove("hidden");
    filledList.innerHTML = STATE.filledReport
      .map(
        (f) =>
          `<div class="fill-line"><strong>${esc(f.label)}</strong> <span class="pill p-blue">${esc(f.source)}</span><div class="muted">${esc(String(f.filledValue).slice(0, 120))}</div></div>`,
      )
      .join("");
  } else {
    filledCard.classList.add("hidden");
  }

  if (askFields.length === 0) {
    askCard.classList.add("hidden");
    return;
  }

  askCard.classList.remove("hidden");
  askList.innerHTML = askFields
    .map(
      (f, idx) => `
      <div class="ask-item" data-idx="${idx}" data-fid="${esc(f.fid)}">
        <div class="ask-label">${esc(f.label)}${f.required ? ' <span style="color:#fb7185;">*</span>' : ""}</div>
        ${f.plan?.hint ? `<div class="muted" style="color:#fde68a;">Hint: ${esc(f.plan.hint)}</div>` : ""}
        ${
          f.options && f.options.length > 0
            ? `<div class="row">${f.options.map((o) => `<span class="opt-chip" data-opt="${esc(o)}">${esc(o)}</span>`).join("")}</div>`
            : ""
        }
        <textarea class="ask-input" placeholder="Type your answer once…">${esc(STATE.draftAnswers[f.fid] || "")}</textarea>
        <label class="chk-line"><input type="checkbox" class="save-mem-chk" checked /> Save &amp; auto-reuse for future forms</label>
        <label class="chk-line"><input type="checkbox" class="save-profile-chk" /> Also save as durable fact in profile memory</label>
        <button class="good save-fill-btn" type="button">Save &amp; Fill Field ✓</button>
      </div>
    `,
    )
    .join("");

  askList.querySelectorAll(".ask-item").forEach((box) => {
    const idx = Number(box.getAttribute("data-idx"));
    const field = askFields[idx];
    const inputEl = box.querySelector(".ask-input");

    inputEl.oninput = () => {
      STATE.draftAnswers[field.fid] = inputEl.value;
    };

    box.querySelectorAll(".opt-chip").forEach((chip) => {
      chip.onclick = () => {
        inputEl.value = chip.getAttribute("data-opt");
        STATE.draftAnswers[field.fid] = inputEl.value;
      };
    });

    box.querySelector(".save-fill-btn").onclick = async () => {
      const answer = inputEl.value.trim();
      if (!answer) return;

      const saveMem = box.querySelector(".save-mem-chk").checked;
      const alsoProfile = box.querySelector(".save-profile-chk").checked;

      const fillRes = await execInFrame(
        STATE.activeTab.id,
        field.frameId ?? 0,
        (fid, kind, val) => window.CareerOpsMatcher.domFillField(fid, kind, val, null),
        [field.fid, field.kind, answer],
      );

      if (fillRes?.ok) {
        if (saveMem) {
          const res = await bg({
            type: "API_SAVE_QA",
            question: field.label,
            answer,
            fieldType: field.kind,
            alsoRememberFact: alsoProfile,
          });
          if (!res?.ok) {
            alert(`Filled page field, but could not save Q&A memory: ${res?.error}`);
          } else {
            STATE.ctx.qaMemory = res.data.store;
            renderMemoryPanel();
          }
        }
        delete STATE.draftAnswers[field.fid];
        STATE.filledReport.push({ label: field.label, source: saveMem ? "saved+filled" : "manual", filledValue: fillRes.filledValue });
        askFields.splice(idx, 1);
        renderAskAndFilled(askFields);
      } else {
        if (Array.isArray(fillRes?.availableOptions) && fillRes.availableOptions.length > 0) {
          field.options = fillRes.availableOptions;
        }
        field.plan = {
          ...(field.plan || {}),
          hint: fillRes?.reason || "Could not match control — select one of the available options cleanly",
        };
        renderAskAndFilled(askFields);
      }
    };
  });
}

async function scanAndAutofill() {
  const ok = await loadContext();
  if (!ok || !STATE.activeTab?.id) return;

  const statsEl = document.getElementById("scanStats");
  statsEl.textContent = "Scanning form controls across page & iframes…";

  try {
    await ensureMatcherInjected(STATE.activeTab.id);
    const frameResults = await execInAllFrames(
      STATE.activeTab.id,
      (ctx) => {
        if (!window.CareerOpsMatcher) return [];
        return window.CareerOpsMatcher.domScanAndResolve({
          profile: ctx.profile,
          matchedItem: ctx.matchedItem,
          qaMemoryEntries: ctx.qaMemory?.entries || [],
        });
      },
      [
        {
          profile: STATE.ctx.profile,
          matchedItem: STATE.matchedItem,
          qaMemory: STATE.ctx.qaMemory,
        },
      ],
    );

    const allFields = [];
    for (const fr of frameResults) {
      const fId = fr.frameId ?? 0;
      for (const field of (fr.result || [])) {
        allFields.push({ ...field, frameId: fId });
      }
    }

    STATE.scannedFields = allFields;
    STATE.filledReport = [];
    STATE.draftAnswers = {};
    const askFields = [];
    const pdfCache = {};
    const highlightByFrame = new Map();

    const reportNum = STATE.matchedItem?.num ?? null;
    const reportNumStr = STATE.matchedItem?.numStr || "";

    for (const f of STATE.scannedFields) {
      if (f.plan?.status === "file") {
        if (!reportNum) {
          askFields.push({
            ...f,
            plan: { hint: "Unmatched external posting — upload your general CV manually so no wrong role-specific CV is attached" },
          });
          if (!highlightByFrame.has(f.frameId)) highlightByFrame.set(f.frameId, []);
          highlightByFrame.get(f.frameId).push(f.fid);
          continue;
        }
        const kind = f.plan.kind === "file_cover" ? "cover" : "cv";
        if (!pdfCache[kind]) {
          const pdfRes = await bg({ type: "API_FETCH_PDF", num: reportNum, numStr: reportNumStr, kind });
          if (pdfRes?.ok) pdfCache[kind] = pdfRes;
        }
        const matchedPdfName =
          (kind === "cover" ? STATE.matchedItem?.coverPdfRel : STATE.matchedItem?.cvPdfRel)?.split("/").pop() || "";
        if (pdfCache[kind]) {
          const r = await execInFrame(
            STATE.activeTab.id,
            f.frameId,
            (fid, fk, fd) => window.CareerOpsMatcher.domFillField(fid, fk, "", fd),
            [f.fid, f.kind, pdfCache[kind]],
          );
          if (r?.ok) {
            STATE.filledReport.push({
              label: f.label,
              source: `${f.plan.source} (#${reportNumStr})`,
              filledValue: matchedPdfName ? `${r.filledValue} · ${matchedPdfName}` : r.filledValue,
            });
          } else {
            askFields.push({ ...f, plan: { hint: `Attach manually (${matchedPdfName || pdfCache[kind].filename})` } });
          }
        } else {
          askFields.push({
            ...f,
            plan: { hint: `Could not fetch tailored PDF for #${reportNumStr} — attach manually (${matchedPdfName || "check Career-Ops server"})` },
          });
          if (!highlightByFrame.has(f.frameId)) highlightByFrame.set(f.frameId, []);
          highlightByFrame.get(f.frameId).push(f.fid);
        }
        continue;
      }

      if (f.plan?.status === "ready") {
        const r = await execInFrame(
          STATE.activeTab.id,
          f.frameId,
          (fid, fk, val) => window.CareerOpsMatcher.domFillField(fid, fk, val, null),
          [f.fid, f.kind, f.plan.value],
        );
        if (r?.ok) {
          STATE.filledReport.push({ label: f.label, source: f.plan.source, filledValue: r.filledValue });
        } else {
          const opts = Array.isArray(r?.availableOptions) && r.availableOptions.length > 0 ? r.availableOptions : f.options;
          askFields.push({
            ...f,
            options: opts,
            plan: { hint: r?.reason || `Pick matching option (${f.plan.value})` },
          });
          if (!highlightByFrame.has(f.frameId)) highlightByFrame.set(f.frameId, []);
          highlightByFrame.get(f.frameId).push(f.fid);
        }
        continue;
      }

      askFields.push(f);
      if (!highlightByFrame.has(f.frameId)) highlightByFrame.set(f.frameId, []);
      highlightByFrame.get(f.frameId).push(f.fid);
    }

    for (const [fId, fids] of highlightByFrame.entries()) {
      await execInFrame(
        STATE.activeTab.id,
        fId,
        (ids) => window.CareerOpsMatcher.domHighlightNeedsInput(ids),
        [fids],
      );
    }

    if (STATE.linkedinJob?.isLinkedIn && !STATE.linkedinJob.easyApplyOpen && STATE.scannedFields.length === 0) {
      statsEl.textContent = "LinkedIn Easy Apply modal is closed — click Easy Apply on LinkedIn first (navbar search is safely ignored).";
    } else {
      statsEl.textContent = `Scanned ${STATE.scannedFields.length} fields · Auto-filled ${STATE.filledReport.length} · Waiting on ${askFields.length}`;
    }
    renderAskAndFilled(askFields);
  } catch (err) {
    statsEl.textContent = `Scan error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

document.getElementById("tabFormBtn").onclick = () => {
  document.getElementById("tabFormBtn").classList.add("active");
  document.getElementById("tabMemoryBtn").classList.remove("active");
  document.getElementById("formPanel").classList.remove("hidden");
  document.getElementById("memoryPanel").classList.add("hidden");
};

document.getElementById("tabMemoryBtn").onclick = () => {
  document.getElementById("tabMemoryBtn").classList.add("active");
  document.getElementById("tabFormBtn").classList.remove("active");
  document.getElementById("memoryPanel").classList.remove("hidden");
  document.getElementById("formPanel").classList.add("hidden");
};

document.getElementById("scanBtn").onclick = scanAndAutofill;
document.getElementById("refreshCtxBtn").onclick = loadContext;
document.getElementById("memSearch").oninput = renderMemoryPanel;

let spaSyncTimer = null;
chrome.tabs.onActivated.addListener(() => {
  loadContext();
});
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (STATE.activeTab?.id && tabId !== STATE.activeTab.id) return;
  if (info.status === "complete") {
    if (spaSyncTimer) clearTimeout(spaSyncTimer);
    loadContext();
    return;
  }
  if (info.url) {
    if (spaSyncTimer) clearTimeout(spaSyncTimer);
    spaSyncTimer = setTimeout(() => {
      loadContext();
    }, 450);
  }
});

loadContext();
