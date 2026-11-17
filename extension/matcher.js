// Shared page field scanner, question matcher, and React-safe DOM autofill helpers.
// Executed inside target job application tabs via chrome.scripting or required in tests.

(function initCareerOpsMatcher(globalScope) {
  function normalizeText(s) {
    return String(s ?? "")
      .replace(/[\u2731*]/g, "")
      .replace(/[’‘]/g, "'")
      .replace(/[“”]/g, '"')
      .replace(/[^a-z0-9\s]/gi, " ")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  function cleanLabel(s) {
    return String(s ?? "")
      .replace(/[\u2731*]/g, "")
      .replace(/[’‘]/g, "'")
      .replace(/[“”]/g, '"')
      .replace(/Upload File or drag and drop here/gi, "")
      .replace(/ATTACH RESUME\/CV/gi, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function siteKey(host) {
    const clean = (host || "").toLowerCase().replace(/^www\./, "");
    const parts = clean.split(".").filter(Boolean);
    if (parts.length <= 2) return clean;
    if (parts.length >= 3 && /^(?:co|com|org|net|ac|gov)$/.test(parts[parts.length - 2]) && parts[parts.length - 1].length === 2) {
      return parts.slice(-3).join(".");
    }
    return parts.slice(-2).join(".");
  }

  function stripApplySuffix(urlStr) {
    try {
      const u = new URL(urlStr);
      u.hash = "";
      const host = u.hostname.toLowerCase();
      if (host.includes("greenhouse.io") && u.searchParams.get("for") && u.searchParams.get("token")) {
        return `gh:${u.searchParams.get("for").toLowerCase()}:${u.searchParams.get("token")}`;
      }
      if (host.includes("greenhouse.io")) {
        const m = u.pathname.match(/\/jobs\/(\d+)/i) || (u.searchParams.get("gh_jid") ? [null, u.searchParams.get("gh_jid")] : null);
        if (m) return `ghid:${m[1]}`;
      }
      if (u.searchParams.get("gh_jid") && /^\d{5,}$/.test(u.searchParams.get("gh_jid"))) {
        return `ghid:${u.searchParams.get("gh_jid")}`;
      }
      if (host.endsWith(".personio.de") || host.endsWith(".personio.com")) {
        const pm = u.pathname.match(/\/job\/(\d+)/i);
        if (pm) return `personio:${host}:${pm[1]}`;
      }
      if (host.includes("myworkdayjobs.com")) {
        u.pathname = u.pathname.replace(/\/apply(?:\/.*)?$/i, "");
        return `${u.origin}${u.pathname.replace(/\/+$/, "").toLowerCase()}`;
      }
      if (host === "linkedin.com" || host.endsWith(".linkedin.com")) {
        const liId =
          (u.pathname.match(/\/jobs\/view\/(\d+)/i) || [])[1] ||
          (u.searchParams.get("currentJobId") && /^\d+$/.test(u.searchParams.get("currentJobId")) ? u.searchParams.get("currentJobId") : "");
        if (liId) return `linkedin:${liId}`;
      }
      // Strip trailing /apply or /application only when a job slug precedes it
      const stripped = u.pathname.replace(/\/(?:application|apply)\/?$/i, "");
      if (stripped && stripped !== "/") {
        u.pathname = stripped;
      }
      return `${u.origin}${u.pathname.replace(/\/+$/, "").toLowerCase()}`;
    } catch {
      return "";
    }
  }

  function urlCanonicalKeys(urlStr) {
    const keys = [];
    const primary = stripApplySuffix(urlStr);
    if (primary) keys.push(primary);
    try {
      const u = new URL(urlStr);
      const host = u.hostname.toLowerCase();
      if (host.includes("greenhouse.io")) {
        const tok = u.searchParams.get("token") || u.searchParams.get("gh_jid") || (u.pathname.match(/\/jobs\/(\d+)/i) || [])[1];
        if (tok && !keys.includes(`ghid:${tok}`)) keys.push(`ghid:${tok}`);
      } else if (u.searchParams.get("gh_jid") && /^\d{5,}$/.test(u.searchParams.get("gh_jid"))) {
        const k = `ghid:${u.searchParams.get("gh_jid")}`;
        if (!keys.includes(k)) keys.push(k);
      } else if (host === "linkedin.com" || host.endsWith(".linkedin.com")) {
        const liId =
          (u.pathname.match(/\/jobs\/view\/(\d+)/i) || [])[1] ||
          (u.searchParams.get("currentJobId") && /^\d+$/.test(u.searchParams.get("currentJobId")) ? u.searchParams.get("currentJobId") : "");
        if (liId) {
          if (!keys.includes(`linkedin:${liId}`)) keys.push(`linkedin:${liId}`);
          const canon = `https://www.linkedin.com/jobs/view/${liId}`;
          if (!keys.includes(canon)) keys.push(canon);
        }
      }
    } catch {}
    return keys;
  }

  function findMatchedItem(tabUrl, items) {
    if (!tabUrl || !Array.isArray(items)) return null;
    const tabKeys = urlCanonicalKeys(tabUrl);
    if (tabKeys.length === 0) return null;
    for (const item of items) {
      const itemKeys = [...urlCanonicalKeys(item.url), ...urlCanonicalKeys(item.applyUrl)];
      if (tabKeys.some((tk) => itemKeys.includes(tk))) {
        return item;
      }
    }
    // Fallback substring match for job UUIDs embedded in URL path/query
    const uuidMatch = tabUrl.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    if (uuidMatch) {
      const uuid = uuidMatch[0].toLowerCase();
      const byUuid = items.find((it) => `${it.url} ${it.applyUrl}`.toLowerCase().includes(uuid));
      if (byUuid) return byUuid;
    }
    // Same-site fallback on Workday requisition IDs (e.g. R120836) or 6-12 digit job IDs (BMW/CARIAD/Greenhouse)
    let tabSite = "";
    try {
      tabSite = siteKey(new URL(tabUrl).hostname);
    } catch {
      return null;
    }
    const idTokens = [
      ...new Set([
        ...(tabUrl.match(/(?:^|[^a-z0-9])(R\d{5,})(?=[^a-z0-9]|$)/gi) || []).map((s) => s.replace(/^[^a-z0-9]+/gi, "").toLowerCase()),
        ...(tabUrl.match(/\b\d{6,12}\b/g) || []),
      ]),
    ];
    if (idTokens.length > 0 && tabSite) {
      for (const item of items) {
        const urls = [item.url, item.applyUrl].filter(Boolean);
        const sameSite = urls.some((u) => {
          try {
            return siteKey(new URL(u).hostname) === tabSite;
          } catch {
            return false;
          }
        });
        if (!sameSite) continue;
        const hay = urls.join(" ").toLowerCase();
        if (idTokens.some((tok) => hay.includes(tok))) return item;
      }
    }
    return null;
  }

  function findInQaMemory(label, qaEntries) {
    if (!Array.isArray(qaEntries) || qaEntries.length === 0) return null;
    const nk = normalizeText(label);
    if (!nk) return null;

    // 1) Exact key match
    for (const e of qaEntries) {
      if (e.key === nk) return e;
    }
    // 2) Prefix overlap on meaningful multi-word questions (>= 22 chars)
    if (nk.length >= 22) {
      for (const e of qaEntries) {
        if (e.key.length >= 22 && (e.key.startsWith(nk) || nk.startsWith(e.key))) {
          return e;
        }
      }
    }
    return null;
  }

  function findInRoleAnswers(label, matchedItem) {
    if (!matchedItem || !Array.isArray(matchedItem.answers)) return null;
    const nk = normalizeText(label);
    if (!nk) return null;
    for (const a of matchedItem.answers) {
      const qk = normalizeText(a.question);
      if (!qk) continue;
      if (qk === nk || (qk.length >= 20 && nk.length >= 20 && (qk.startsWith(nk) || nk.startsWith(qk)))) {
        return a;
      }
    }
    return null;
  }

  function resolveBaselineProfile(field, profile, matchedItem, meta = {}) {
    const sl = normalizeText(field.label);
    const fname = String(field.name || "").toLowerCase();
    const emailToUse = profile.baseEmail || "sajiv2580@gmail.com";

    if (/pronunciation|pronounciation|phonetically/.test(sl)) return profile.phoneticName;
    if (/pronouns/.test(sl)) return profile.pronouns;
    if (/^(?:legal )?first name$|^preferred first name$/.test(sl) || fname === "firstname") return profile.firstName;
    if (/^(?:legal )?(?:last name|surname)$/.test(sl) || fname === "lastname") return profile.lastName;
    if (/^(?:full name|preferred full name|preferred first last name|preferred name|name)$/.test(sl) || /what is your preferred name|what would you like us to call you/.test(sl)) {
      return profile.fullName;
    }
    if (/^email(?: address| enter your email)?$/.test(sl) || field.inputType === "email" || fname === "email") {
      return emailToUse;
    }
    if (/phone country code|country code.*phone/.test(sl)) {
      return "India (+91)";
    }
    if (/mobile phone|\bphone\b/.test(sl) || field.inputType === "tel" || fname === "phone") {
      if (meta.hasPhoneCountryCode && profile.phone) {
        const localNum = String(profile.phone).replace(/^\+91\s*/, "").trim();
        if (/^\d{10}$/.test(localNum)) return localNum;
      }
      return profile.phone;
    }
    if (/linkedin/.test(sl) || /linkedin/.test(fname)) return profile.linkedin;
    if (/github.*username/.test(sl)) return profile.githubUsername;
    if (/github/.test(sl) || /github/.test(fname)) return profile.github;
    if (/portfolio|website|^other$/.test(sl) || /website|portfolio/.test(fname)) return profile.portfolio;
    if (/^headline$/.test(sl)) return "Applied AI / ML & Software Engineer | B.Tech 2027";
    if (/current company/.test(sl) || fname === "org") return profile.currentCompany;
    if (/university|school|college/.test(sl)) return profile.university;
    if (/cumulative gpa|overall average grade|cgpa|\bgpa\b/.test(sl)) return profile.cgpa;
    if (/anticipated graduation|ancitipated graduation|graduation/.test(sl)) return profile.graduation;
    if (/^country$|^city$|^home city$|^location(?:\s+city)?$|current location|city and country|residing in|country you re currently|what is your location/.test(sl)) return profile.location;
    if (/spoken languages|languages are you fluent/.test(sl)) return profile.languages;
    if (/cover letter/.test(sl) && field.tag === "textarea" && matchedItem?.coverText) {
      return matchedItem.coverText;
    }
    if (/previously employed by/.test(sl)) return "No";
    if (/consent to contact me about future job|consent to recruitment privacy|privacy policy|privacy notice/.test(sl)) {
      return "Yes";
    }
    if (matchedItem?.country) {
      const ctry = String(matchedItem.country).toUpperCase();
      if (/require sponsorship|visa sponsorship|need.*sponsorship|sponsorship for employment/.test(sl)) {
        return ctry === "IN" ? "No" : "Yes";
      }
      if (/legally authorized to work|legally permitted to work|authorized to work in/.test(sl)) {
        return ctry === "IN" ? "Yes" : "No";
      }
    }
    if (/have you used elevenlabs/.test(sl)) {
      if (field.kind === "radio" || field.kind === "button_group" || field.kind === "checkbox_group") return "No";
      return "No — I have not used ElevenLabs in a production or side project yet. In my own audio and voice AI work, I built automated Whisper synchronization and Tamil TTS pipelines in Reporzo, Coqui XTTS-v2 narration with OpenAI-to-Gemini failover in Reporzo DailyFacts, voice-to-text coding workflows in MuseFlow / Jess IDE, and real-time speech/pitch tracking (TensorFlow, CREPE, Librosa, FastDTW) in Voice Shiksha.";
    }
    if (/how did you hear|where did you.*hear|first hear about/.test(sl)) {
      return "Company website";
    }
    if (/gender|ethnicity|racial|race|veteran|disability|chronic condition|sexual orientation|transgender|age group|religion/.test(sl)) {
      return "Prefer not to say";
    }
    return null;
  }

  function resolveFieldPlan(field, ctx, meta = {}) {
    const { profile, matchedItem, qaMemoryEntries } = ctx;
    if (field.kind === "file_resume" || field.kind === "file_cover") {
      return {
        status: "file",
        kind: field.kind,
        source: matchedItem ? "role_pdf" : "default_pdf",
        value: matchedItem ? `Report #${matchedItem.numStr} tailored PDF` : "Default CV PDF",
      };
    }

    // 1. Learned personal Q&A memory always wins
    const memHit = findInQaMemory(field.label, qaMemoryEntries);
    let candidate = null;
    if (memHit && memHit.answer) {
      candidate = { source: "qa_memory", value: memHit.answer };
    }

    // 2. Role-specific pre-generated answers (skip [Confirm personally] items so user answers once!)
    if (!candidate) {
      const roleHit = findInRoleAnswers(field.label, matchedItem);
      if (roleHit) {
        const isPersonalFlag = roleHit.needsConfirm || /^\[(?:Confirm|Needs)/i.test(roleHit.answer);
        if (isPersonalFlag) {
          return { status: "ask", source: "confirm_needed", hint: roleHit.answer };
        }
        if (roleHit.answer) {
          candidate = { source: "role_answer", value: roleHit.answer };
        }
      }
    }

    // 3. Verified profile defaults (for any job portal globally)
    if (!candidate) {
      const baseVal = resolveBaselineProfile(field, profile, matchedItem, meta);
      if (baseVal) {
        candidate = { source: "profile", value: baseVal };
      }
    }

    if (candidate) {
      // If this field is a choice/dropdown with known options upfront, verify a relevant option actually matches
      // instead of claiming ready with a mismatched text string.
      const hasStaticOptions =
        (field.kind === "select" || field.kind === "radio" || field.kind === "checkbox_group" || field.kind === "button_group" || field.kind === "combobox") &&
        Array.isArray(field.options) &&
        field.options.length > 0;
      if (hasStaticOptions && pickBestOption(candidate.value, field.options, field.label) < 0) {
        return {
          status: "ask",
          source: "confirm_needed",
          hint: `Dropdown choice needed — answer "${String(candidate.value).slice(0, 70)}" does not clearly match available options`,
        };
      }
      return { status: "ready", source: candidate.source, value: candidate.value };
    }

    // 4. Ask candidate cleanly
    return { status: "ask", source: "new_question", hint: "" };
  }

  function isVisibleControl(el) {
    if (!el) return false;
    if (el.type === "file") return true;
    const cls = String(el.className || "");
    // Skip React-Select hidden validator inputs (1px requiredInput) & intl-tel-input country search box
    if (/requiredInput/i.test(cls)) return false;
    if (el.closest('[aria-hidden="true"], .iti__dropdown-content')) return false;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
    const r = el.getBoundingClientRect();
    return r.width > 1 || r.height > 1;
  }

  function readCleanNodeText(node) {
    if (!node) return "";
    const clone = node.cloneNode(true);
    clone
      .querySelectorAll(
        "input, select, textarea, button, [role='listbox'], .visually-hidden, .sr-only, .artdeco-assistive-text, .fb-dash-form-element__error-field, [data-test-form-element-error], [role='alert']",
      )
      .forEach((n) => n.remove());
    let raw = (clone.innerText || clone.textContent || "").trim();
    const lines = raw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !/^(?:required|\*?required|\(optional\))$/i.test(l));
    // Collapse LinkedIn-style duplicate label spans (<span aria-hidden> + fallback text)
    const dedup = [];
    for (const l of lines) {
      if (dedup.length === 0 || dedup[dedup.length - 1] !== l) dedup.push(l);
    }
    raw = dedup.join(" ").replace(/\s+(?:required|\(optional\))$/i, "").trim();
    return cleanLabel(raw);
  }

  function extractFieldLabel(el) {
    if (el.id) {
      const lbl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (lbl) {
        const t = readCleanNodeText(lbl);
        if (t) return t;
      }
    }
    const wrapLabel = el.closest("label");
    if (wrapLabel) {
      const t = readCleanNodeText(wrapLabel);
      if (t) return t;
    }
    if (el.getAttribute("aria-labelledby")) {
      const parts = el
        .getAttribute("aria-labelledby")
        .split(/\s+/)
        .map((id) => readCleanNodeText(document.getElementById(id)))
        .filter(Boolean);
      const joined = cleanLabel([...new Set(parts)].join(" "));
      if (joined) return joined;
    }
    if (el.getAttribute("aria-label") && !/^select\b/i.test(el.getAttribute("aria-label"))) {
      return cleanLabel(el.getAttribute("aria-label"));
    }

    const container = el.closest(
      ".fb-dash-form-element, .jobs-easy-apply-form-element, .application-question, .application-field, [class*='fieldEntry'], [class*='formField'], [data-field-id], fieldset, .field, [role='group'], .select, .select-shell",
    );
    if (container) {
      const head = container.querySelector(".fb-dash-form-element__label, label, legend, h3, h4, .label, [class*='label'], [id$='-label']");
      if (head && !head.contains(el)) {
        const t = readCleanNodeText(head);
        if (t) return t;
      }
    }

    // Walk up briefly for Greenhouse Remix wrappers (label sibling 2-4 levels above .select__input)
    let cur = el.parentElement;
    for (let depth = 0; depth < 4 && cur && cur.tagName !== "FORM"; depth++) {
      const head = cur.querySelector(":scope > label, :scope > .label, :scope > [id$='-label']");
      if (head && !head.contains(el)) {
        const t = readCleanNodeText(head);
        if (t) return t;
      }
      cur = cur.parentElement;
    }

    if (el.type === "file") {
      const hint = `${el.id || ""} ${el.name || ""} ${el.closest("div")?.parentElement?.innerText || ""}`.toLowerCase();
      if (/cover[-_ ]?letter/.test(hint)) return "Cover Letter Upload";
      if (/resume|cv|doc,\s*docx,\s*pdf/.test(hint)) return "Resume Upload";
    }

    const ph = el.getAttribute("placeholder") || "";
    if (/^(start typing|select\.{0,3}|search)$/i.test(ph.trim())) {
      return cleanLabel(el.id || el.name || "");
    }
    return cleanLabel(ph || el.getAttribute("name") || el.id || "");
  }

  function isLinkedInHost() {
    try {
      const h = window.location.hostname.toLowerCase();
      return h === "linkedin.com" || h.endsWith(".linkedin.com");
    } catch {
      return false;
    }
  }

  function getLinkedInEasyApplyModalRoot() {
    if (!isLinkedInHost()) return null;
    const candidates = [
      ...document.querySelectorAll(
        '.jobs-easy-apply-modal, [data-test-modal-id="easy-apply-modal"], .artdeco-modal[role="dialog"], [role="dialog"]',
      ),
    ];
    for (const dlg of candidates) {
      const st = window.getComputedStyle(dlg);
      if (st.display === "none" || st.visibility === "hidden" || st.opacity === "0") continue;
      const r = dlg.getBoundingClientRect();
      if (r.width < 120 || r.height < 120) continue;
      const cls = String(dlg.className || "");
      const txt = (dlg.innerText || "").slice(0, 400);
      if (
        /jobs-easy-apply/i.test(cls) ||
        dlg.querySelector(".jobs-easy-apply-content, .fb-dash-form-element, .jobs-easy-apply-form-section__grouping") ||
        /\b(?:apply to|contact info|resume|submit application|next|review your application)\b/i.test(txt)
      ) {
        return dlg;
      }
    }
    return null;
  }

  function domExtractLinkedInJob() {
    const isLinkedIn = isLinkedInHost();
    if (!isLinkedIn) return { isLinkedIn: false };

    const href = window.location.href;
    let jobId = "";
    try {
      const u = new URL(href);
      jobId =
        (u.pathname.match(/\/jobs\/view\/(\d+)/i) || [])[1] ||
        (u.searchParams.get("currentJobId") && /^\d+$/.test(u.searchParams.get("currentJobId")) ? u.searchParams.get("currentJobId") : "");
    } catch {}
    if (!jobId) {
      const dataEl = document.querySelector("[data-job-id], .jobs-search__job-details [data-occludable-job-id]");
      const attrId = dataEl?.getAttribute("data-job-id") || dataEl?.getAttribute("data-occludable-job-id") || "";
      const m = attrId.match(/\d{6,}/);
      if (m) jobId = m[0];
    }

    const modalRoot = getLinkedInEasyApplyModalRoot();
    const pickText = (selectors) => {
      for (const sel of selectors) {
        const n = document.querySelector(sel);
        const t = cleanLabel(n?.innerText || n?.textContent || "");
        if (t) return t;
      }
      return "";
    };

    let company = pickText([
      ".job-details-jobs-unified-top-card__company-name a",
      ".job-details-jobs-unified-top-card__company-name",
      ".jobs-unified-top-card__company-name a",
      ".jobs-unified-top-card__company-name",
      ".topcard__org-name-link",
    ]);
    if (!company && modalRoot) {
      const hdr = cleanLabel(modalRoot.querySelector("#jobs-apply-header, h2")?.innerText || "");
      const m = hdr.match(/^apply to\s+(.+)$/i);
      if (m) company = m[1].trim();
    }

    const title = pickText([
      ".job-details-jobs-unified-top-card__job-title h1",
      ".job-details-jobs-unified-top-card__job-title a",
      ".job-details-jobs-unified-top-card__job-title",
      ".jobs-unified-top-card__job-title",
      "h1.t-24",
      "h1.topcard__title",
    ]);

    let location = "";
    const locRaw = pickText([
      ".job-details-jobs-unified-top-card__primary-description-container",
      ".job-details-jobs-unified-top-card__tertiary-description-container",
      ".jobs-unified-top-card__bullet",
      ".topcard__flavor--bullet",
    ]);
    if (locRaw) {
      const seg = locRaw
        .split(/[·•|]/)
        .map((s) => s.trim())
        .find((s) => s && !/\b(?:\d+\s+(?:day|week|month|hour|minute)s?\s+ago|republished|applicant|clicked apply)\b/i.test(s));
      if (seg) location = seg;
    }

    const jdNode =
      document.querySelector("#job-details") ||
      document.querySelector(".jobs-description__content .jobs-box__html-content") ||
      document.querySelector(".jobs-description__content") ||
      document.querySelector(".jobs-description-content__text") ||
      document.querySelector(".show-more-less-html__markup");
    const jdText = String(jdNode?.innerText || "")
      .replace(/\r/g, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    const jdLoaded = jdText.length >= 120 && !/^loading\b/i.test(jdText);

    const applyBtns = [...document.querySelectorAll(".jobs-apply-button, button[aria-label*='Easy Apply'], button[aria-label*='Apply']")];
    const hasEasyApplyButton = applyBtns.some((b) => /\beasy apply\b/i.test(`${b.innerText || ""} ${b.getAttribute("aria-label") || ""}`));

    const canonicalUrl = jobId ? `https://www.linkedin.com/jobs/view/${jobId}/` : href.split("#")[0];
    const isJobPage = /\/jobs\//i.test(window.location.pathname) || Boolean(modalRoot);

    return {
      isLinkedIn: true,
      isJobPage,
      jobId,
      canonicalUrl,
      title,
      company,
      location,
      jdText: jdText.slice(0, 12000),
      jdLoaded,
      easyApplyOpen: Boolean(modalRoot),
      hasEasyApplyButton,
    };
  }

  function isDropdownInput(el) {
    if (!el) return false;
    const tag = el.tagName.toLowerCase();
    if (tag === "select") return true;
    if (tag === "textarea") return false;
    const role = (el.getAttribute("role") || "").toLowerCase();
    const haspopup = (el.getAttribute("aria-haspopup") || "").toLowerCase();
    const ac = (el.getAttribute("aria-autocomplete") || "").toLowerCase();
    const cls = String(el.className || "");
    if (role === "combobox" || haspopup === "listbox" || haspopup === "true" || ac === "list" || ac === "both") {
      return true;
    }
    if (tag === "input" && el.getAttribute("list")) return true;
    if (/select__input|autocomplete|combobox|basic-typeahead__input|search-basic-typeahead/i.test(cls)) return true;
    if (el.closest(".select__container, .select-shell, .search-basic-typeahead, .basic-typeahead, [class*='select__control'], [class*='combobox'], [class*='Combobox']")) {
      return true;
    }
    return false;
  }

  // DOM Page Scanner & Injector (runs inside the webpage tab)
  function domScanAndResolve(ctx) {
    const NOISE_LABELS = new Set([
      "", "search", "search jobs", "create alert", "submit", "apply", "next", "continue",
      "upload file or drag and drop here",
    ]);

    const onLinkedIn = isLinkedInHost();
    const modalRoot = onLinkedIn ? getLinkedInEasyApplyModalRoot() : null;
    // Never touch LinkedIn navbar search / feed alert widgets when Easy Apply dialog isn't open
    if (onLinkedIn && !modalRoot) {
      return [];
    }
    const scanRoot = modalRoot || document;
    const hasResumeFileControl = [...scanRoot.querySelectorAll('input[type="file"]')].some(
      (f) => !/cover/i.test(`${f.id || ""} ${f.name || ""}`),
    );

    const isVisible = isVisibleControl;
    const extractLabel = extractFieldLabel;

    const rawFields = [];
    const seenGroups = new Set();
    let seq = 0;

    // Radio groups first (prevent treating every Yes/No radio option as a separate field)
    const radios = [...scanRoot.querySelectorAll('input[type="radio"]')].filter(isVisible);
    const radioByName = new Map();
    for (const r of radios) {
      const gName = r.name || r.closest("[role='radiogroup']")?.id || `rg_${seq}`;
      if (!radioByName.has(gName)) radioByName.set(gName, []);
      radioByName.get(gName).push(r);
    }

    for (const [gName, groupRadios] of radioByName.entries()) {
      if (seenGroups.has(gName)) continue;
      seenGroups.add(gName);
      // On LinkedIn Easy Apply resume step, skip old pre-uploaded PDF radio cards when a file uploader is active
      if (
        onLinkedIn &&
        hasResumeFileControl &&
        groupRadios.some((r) => r.closest(".jobs-document-upload-redesign-card__container, .jobs-resume-card"))
      ) {
        continue;
      }
      const container = groupRadios[0].closest(
        "[role='radiogroup'], fieldset, .fb-dash-form-element, .application-question, [class*='fieldEntry'], [class*='formField']",
      );
      let groupLabel = "";
      if (container) {
        const lbl = container.querySelector("legend, .fb-dash-form-element__label, label:first-of-type, h3, h4, .label, [class*='label']");
        if (lbl) groupLabel = readCleanNodeText(lbl);
      }
      if (!groupLabel) groupLabel = cleanLabel(gName);
      if (NOISE_LABELS.has(normalizeText(groupLabel))) continue;

      const fid = `co_${seq++}`;
      const options = groupRadios
        .map((r) => {
          const wrapLbl = r.closest("label");
          const forLbl = r.id ? document.querySelector(`label[for="${CSS.escape(r.id)}"]`) : null;
          return readCleanNodeText(wrapLbl || forLbl) || cleanLabel(r.value || "");
        })
        .filter(Boolean);
      const checked = groupRadios.find((r) => r.checked);
      groupRadios.forEach((r) => r.setAttribute("data-careerops-fid", fid));

      rawFields.push({
        fid,
        kind: "radio",
        tag: "input",
        inputType: "radio",
        name: gName,
        label: groupLabel,
        options,
        currentValue: checked ? cleanLabel(readCleanNodeText(checked.closest("label")) || checked.value) : "",
        required: groupRadios.some((r) => r.required || r.getAttribute("aria-required") === "true"),
      });
    }

    // Multi-checkbox question groups (e.g. Lever Pronouns / Previously Employed / LinkedIn checkboxes)
    const groupedCheckboxes = new Set();
    const qGroups = [...scanRoot.querySelectorAll(".application-question, fieldset, [role='group'], .fb-dash-form-element, [class*='fieldEntry']")];
    for (const box of qGroups) {
      const chks = [...box.querySelectorAll('input[type="checkbox"]')].filter(isVisible);
      if (chks.length < 2) continue;
      chks.forEach((c) => groupedCheckboxes.add(c));
      const head = box.querySelector(".application-label, legend, .fb-dash-form-element__label, label:first-of-type, h3, h4, .label, [class*='label']");
      const groupLabel = head ? readCleanNodeText(head) : cleanLabel(chks[0].name || "");
      if (!groupLabel || NOISE_LABELS.has(normalizeText(groupLabel))) continue;

      const fid = `co_${seq++}`;
      const options = chks
        .map((c) => readCleanNodeText(c.closest("label")) || cleanLabel(c.value || ""))
        .filter(Boolean);
      const checked = chks.find((c) => c.checked);
      chks.forEach((c) => c.setAttribute("data-careerops-fid", fid));

      rawFields.push({
        fid,
        kind: "checkbox_group",
        tag: "input",
        inputType: "checkbox_group",
        name: chks[0].name || fid,
        label: groupLabel,
        options,
        currentValue: checked ? cleanLabel(readCleanNodeText(checked.closest("label")) || checked.value) : "",
        required: chks.some((c) => c.required || c.getAttribute("aria-required") === "true"),
      });
    }

    // Remaining controls (text, email, tel, url, number, textarea, select, custom combobox dropdowns, single checkbox, file)
    const controls = [
      ...scanRoot.querySelectorAll('input:not([type="hidden"]):not([type="radio"]):not([type="submit"]):not([type="button"]):not([type="reset"]), textarea, select, button[role="combobox"], button[aria-haspopup="listbox"], [role="combobox"]:not(input):not(textarea):not(select)'),
    ].filter((el) => {
      if (!isVisible(el) || groupedCheckboxes.has(el)) return false;
      if (el.closest(".iti__country-container") && el.tagName === "BUTTON") return false;
      if (el.tagName !== "INPUT" && el.tagName !== "SELECT" && el.tagName !== "TEXTAREA") {
        // Avoid double-scanning a combobox wrapper that already contains an inner combobox <input>
        const inner = el.querySelector('input[role="combobox"], input.select__input');
        if (inner && isVisible(inner)) return false;
      }
      return true;
    });

    for (const el of controls) {
      const elName = (el.name || el.id || "").toLowerCase();
      if (/recaptcha|h-captcha|turnstile|alert/.test(elName)) continue;
      if (el.type === "search" && /search|filter|jobs|iti/.test(elName + " " + (el.className || ""))) continue;

      let label = extractLabel(el);
      if (el.type === "file") {
        if (/cover/i.test(`${label} ${elName}`)) label = label || "Cover Letter Upload";
        else if (!label || /doc.*pdf|upload resume/i.test(label)) label = "Resume Upload";
      }
      if (NOISE_LABELS.has(normalizeText(label))) continue;

      const tag = el.tagName.toLowerCase();
      const inputType = tag === "input" ? (el.type || "text").toLowerCase() : tag;
      let kind = tag;
      if (inputType === "file") {
        // Never upload into Ashby's "Autofill from resume" parser dropzone — it asynchronously overwrites form fields!
        const boxTxt = (el.closest("div")?.parentElement?.innerText || label || "").toLowerCase();
        if (/autofill from resume/.test(boxTxt) && !/_systemfield_resume/.test(el.id || "")) continue;
        kind = /cover/i.test(`${label} ${elName}`) ? "file_cover" : "file_resume";
      } else if (tag === "select") {
        kind = "select";
      } else if (inputType === "checkbox") {
        kind = "checkbox";
      } else if (isDropdownInput(el)) {
        kind = "combobox";
      }

      const fid = `co_${seq++}`;
      el.setAttribute("data-careerops-fid", fid);

      let options = [];
      if (tag === "select") {
        options = [...el.options].map((o) => cleanLabel(o.textContent)).filter((t) => t && !/^select\b/i.test(t));
      } else if (tag === "input" && el.list) {
        options = [...el.list.options].map((o) => cleanLabel(o.value || o.textContent)).filter(Boolean);
      }

      let currentValue = "";
      if (inputType === "file") {
        currentValue = (el.files && el.files[0]?.name) || "";
      } else if (inputType === "checkbox") {
        currentValue = el.checked ? "checked" : "";
      } else if (kind === "combobox" && tag !== "input") {
        const curTxt = cleanLabel(el.innerText || "");
        currentValue = /^select\b/i.test(curTxt) ? "" : curTxt;
      } else {
        const valContainer = kind === "combobox" ? el.closest(".select__value-container, [class*='select__control']") : null;
        const singleVal = valContainer?.querySelector(".select__single-value, [class*='singleValue']");
        currentValue = singleVal ? cleanLabel(singleVal.innerText) : String(el.value || "").trim();
      }

      rawFields.push({
        fid,
        kind,
        tag,
        inputType,
        name: el.name || el.id || "",
        label: label || `Field (${el.name || inputType})`,
        options,
        currentValue,
        required: Boolean(el.required || el.getAttribute("aria-required") === "true"),
      });
    }

    // Ashby-style button-toggle groups (e.g. Yes / No buttons without native <input type="radio">)
    const containers = [...scanRoot.querySelectorAll("[class*='fieldEntry'], [class*='formField'], .application-question")];
    for (const box of containers) {
      if (box.querySelector("input, textarea, select")) continue;
      const btns = [...box.querySelectorAll("button")].filter(isVisible);
      if (btns.length < 2 || btns.length > 8) continue;
      const head = box.querySelector("label, h3, h4, [class*='label'], span");
      const label = head ? readCleanNodeText(head) : "";
      if (!label || NOISE_LABELS.has(normalizeText(label))) continue;

      const fid = `co_${seq++}`;
      const options = btns.map((b) => cleanLabel(b.innerText)).filter(Boolean);
      btns.forEach((b) => b.setAttribute("data-careerops-fid", fid));

      rawFields.push({
        fid,
        kind: "button_group",
        tag: "button",
        inputType: "button_group",
        name: fid,
        label,
        options,
        currentValue: "",
        required: Boolean(box.querySelector("[aria-required='true'], [class*='required']")),
      });
    }

    const hasPhoneCountryCode = rawFields.some((f) => /phone country code|country code.*phone/i.test(normalizeText(f.label)));
    const meta = { hasPhoneCountryCode };
    return rawFields.map((fObj) => ({ ...fObj, plan: resolveFieldPlan(fObj, ctx, meta) }));
  }

  function setReactValue(el, value, skipBlur = false) {
    const proto =
      el.tagName === "TEXTAREA"
        ? HTMLTextAreaElement.prototype
        : el.tagName === "SELECT"
          ? HTMLSelectElement.prototype
          : HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
    if (descriptor && descriptor.set) {
      descriptor.set.call(el, value);
    } else {
      el.value = value;
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    if (!skipBlur) {
      el.dispatchEvent(new Event("blur", { bubbles: true }));
    }
  }

  function isPlaceholderOption(text) {
    const t = cleanLabel(text).toLowerCase();
    return !t || /^select(?:\s+one|\s+an\s+option|\.\.\.)?$/.test(t) || /^choose(?:\s+an\s+option)?$/.test(t) || /^-+$/.test(t) || t === "no options";
  }

  function pickBestOption(desired, optionLabels, fieldLabel = "") {
    const dNorm = normalizeText(desired);
    const lNorm = normalizeText(fieldLabel);
    if (!dNorm || !Array.isArray(optionLabels) || optionLabels.length === 0) return -1;

    // 1. Exact normalized match
    for (let i = 0; i < optionLabels.length; i++) {
      if (isPlaceholderOption(optionLabels[i])) continue;
      if (normalizeText(optionLabels[i]) === dNorm) return i;
    }

    const dClean = cleanLabel(desired).toLowerCase();
    const stopWords = new Set(["the", "and", "for", "with", "that", "this", "are", "you", "your", "have", "from", "will", "not", "yes", "any", "all", "can", "into", "about", "our"]);
    const dTokens = dNorm.split(/\s+/).filter((w) => w.length >= 2 && !stopWords.has(w));
    const dLeadingYes = /^yes\b/.test(dNorm);
    const dLeadingNo = /^no\b/.test(dNorm);

    const dNeedsSponsor =
      /\b(require|requires|need|needs)\s+(?:a\s+|an\s+|visa\s+)?sponsorship\b|\bvisa sponsorship\b/.test(dNorm) &&
      !/\b(?:not|don t|do not|no|without)\s+(?:require|need)\s+(?:a\s+|an\s+|visa\s+)?sponsorship\b/.test(dNorm);
    const dNoSponsor =
      /\b(?:not|don t|do not|without)\s+(?:require|need)\s+(?:a\s+|an\s+|visa\s+)?sponsorship\b|\bno sponsorship\b/.test(dNorm);
    const dPreferDecline = /\b(prefer not|decline|not to say|do not wish|don t wish)\b/i.test(dClean);
    const dIsCompanySite = /\b(company website|careers page|careers site)\b/.test(dNorm);
    const dIsOther = /^other\b/.test(dNorm);
    const dYearMatch = dNorm.match(/\b(202[4-9]|203\d)\b/);
    const dIsBachelor = /\b(b tech|btech|bachelor|b e\b|undergraduate|bsc|b s\b|b eng)\b/.test(dNorm);
    const dCountryCityTokens = cleanLabel(desired)
      .split(/[,/\-|]+/)
      .map((p) => normalizeText(p))
      .filter((p) => p.length >= 3);

    const isTerseYesNoList =
      optionLabels.filter((o) => !isPlaceholderOption(o)).length <= 4 &&
      optionLabels.every((o) => isPlaceholderOption(o) || /^(yes|no|n a|prefer not to say|decline|unsure)\b/i.test(cleanLabel(o)));

    let bestIdx = -1;
    let bestScore = 0;

    for (let i = 0; i < optionLabels.length; i++) {
      const rawOpt = cleanLabel(optionLabels[i]);
      if (isPlaceholderOption(rawOpt)) continue;
      const oNorm = normalizeText(rawOpt);
      if (!oNorm) continue;

      let score = 0;

      // Sponsorship / visa polarity checks (never pick opposite meaning!)
      const oNotRequire = /\b(?:not|don t|do not|no|never|without)\s+(?:now\s+or\s+in\s+the\s+future\s+)?(?:require|need)\b/.test(oNorm);
      const oRequire = /\b(?:require|need)\s+(?:both\s+)?(?:a\s+|an\s+|visa\s+)?sponsorship\b|\brequire\s+sponsorship\b/.test(oNorm) && !oNotRequire;
      if (dNeedsSponsor) {
        if (oNotRequire) continue; // Disqualify opposite option
        if (oRequire) score += 95;
      }
      if (dNoSponsor) {
        if (oRequire) continue; // Disqualify opposite option
        if (oNotRequire) score += 95;
      }

      // EEO / Decline to identify options ("I don't wish to answer", "Decline To Self Identify")
      if (dPreferDecline) {
        if (/prefer not|decline|don'?t wish|do not wish|not to answer|choose not|did not|not specified/i.test(rawOpt)) {
          score += 90;
        }
      }

      // Country / location segment match (word-bounded so "india" never hits "indiana")
      for (let segIdx = dCountryCityTokens.length - 1; segIdx >= 0; segIdx--) {
        const seg = dCountryCityTokens[segIdx];
        if (oNorm === seg) {
          score += segIdx === dCountryCityTokens.length - 1 ? 95 : 85;
        } else if (new RegExp(`\\b${seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(oNorm)) {
          score += 55;
        }
      }

      // Graduation year & Bachelor's degree dropdowns
      if (dYearMatch && new RegExp(`\\b${dYearMatch[1]}\\b`).test(oNorm)) {
        score += 80;
      }
      if (dIsBachelor && /\b(bachelor|undergraduate|b tech|b s\b|bs\b|ba\b|b eng)\b/.test(oNorm)) {
        score += 80;
      }
      if (/\b(bachelor|undergraduate)\b/.test(oNorm) && /\b(phd|doctorate|master)\b/.test(oNorm) === false && dIsBachelor) {
        score += 10;
      }
      if (dIsBachelor && /\b(phd|doctorate|high school)\b/.test(oNorm)) {
        score -= 40;
      }

      // Referral / How did you hear about us
      if (dIsCompanySite) {
        if (/company website|careers|direct|job board/i.test(rawOpt)) score += 80;
        else if (/^other\b/i.test(rawOpt)) score += 20;
      }
      if (dIsOther && /^other\b/i.test(rawOpt)) {
        score += 90;
      }

      // Yes / No handling for binary or leading answers
      if (dLeadingYes && /^yes\b/.test(oNorm)) {
        score += isTerseYesNoList || oNorm === "yes" ? 85 : 40;
      }
      if (dLeadingNo && /^no\b/.test(oNorm)) {
        if (!dNeedsSponsor || !oNotRequire) {
          score += isTerseYesNoList || oNorm === "no" ? 85 : 40;
        }
      }

      // Experience year bracket sanity (prevent <1yr student answer matching 3-5 / 5+)
      if (/\byears?\b|experience/.test(lNorm) && /\b(0|1|intern|student|2027)\b/.test(dNorm)) {
        if (/\b(?:0|less than 1|under 1|< 1)\b/.test(oNorm)) score += 60;
        else if (/\b(?:3|4|5|6|7|8|10)\+?\b/.test(oNorm)) score -= 50;
      }

      // Substring containment (strictly guarded: non-trivial length >= 4)
      if (oNorm.length >= 4 && dNorm.includes(oNorm)) {
        score += 30 + Math.min(30, oNorm.length);
      } else if (dNorm.length >= 4 && oNorm.includes(dNorm)) {
        score += 35 + Math.min(30, dNorm.length);
      }

      // Word token overlap
      if (dTokens.length > 0) {
        const oSet = new Set(oNorm.split(/\s+/).filter((w) => w.length >= 2 && !stopWords.has(w)));
        let hits = 0;
        for (const t of dTokens) {
          if (oSet.has(t)) hits++;
        }
        if (hits > 0 && oSet.size > 0) {
          score += Math.round((hits / Math.max(oSet.size, 1)) * 45) + hits * 8;
        }
      }

      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }

    // Require meaningful confidence so dropdowns NEVER pick an unrelated random option
    return bestScore >= 40 ? bestIdx : -1;
  }

  function findVisibleDropdownOptions(el) {
    const isOptVis = (opt) => {
      if (!opt) return false;
      if (opt.closest(".iti__country-container, .iti__dropdown-content, .iti__country-list, [aria-hidden='true']")) {
        return false;
      }
      const st = window.getComputedStyle(opt);
      if (st.display === "none" || st.visibility === "hidden" || st.opacity === "0") return false;
      const r = opt.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };

    const seen = new Set();
    const collected = [];
    const addNodes = (nodes) => {
      for (const n of nodes) {
        if (!n || seen.has(n) || !isOptVis(n)) continue;
        seen.add(n);
        const txt = cleanLabel(n.innerText || n.textContent || "");
        if (!txt || isPlaceholderOption(txt)) continue;
        collected.push({ el: n, text: txt });
      }
    };

    const ctrlId = el.getAttribute("aria-controls") || el.getAttribute("aria-owns");
    if (ctrlId) {
      const target = document.getElementById(ctrlId);
      if (target) {
        addNodes(target.querySelectorAll('[role="option"], li, [class*="option"]'));
      }
    }
    if (collected.length === 0) {
      const scope = el.closest(".select__container, .select-shell, .search-basic-typeahead, .basic-typeahead, [class*='combobox'], [class*='Combobox'], [class*='fieldEntry'], [class*='formField']");
      if (scope) {
        addNodes(scope.querySelectorAll('.select__menu [role="option"], .select__option, .basic-typeahead__triggered-content [role="option"], .basic-typeahead__selectable, [role="listbox"] [role="option"], [class*="__option"], [role="listbox"] li'));
      }
    }
    if (collected.length === 0) {
      addNodes(document.querySelectorAll('.select__menu [role="option"], .select__menu .select__option, [id^="react-select-"][id*="-option-"], .basic-typeahead__triggered-content [role="option"], .basic-typeahead__selectable, [role="listbox"]:not(.iti__country-list) [role="option"], ul[role="listbox"]:not(.iti__country-list) > li'));
    }
    return collected;
  }

  async function fillComboboxField(el, value, fieldLabel) {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const highlightBox = el.closest(".select__control, [class*='select__control'], [class*='combobox']") || el;

    // 1. HTML <datalist> input
    if (el.tagName === "INPUT" && el.list && el.list.options?.length) {
      const optTexts = [...el.list.options].map((o) => cleanLabel(o.value || o.textContent)).filter(Boolean);
      const idx = pickBestOption(value, optTexts, fieldLabel);
      if (idx < 0) {
        highlightBox.style.outline = "2px solid #f59e0b";
        return { ok: false, reason: `No matching dropdown option for "${String(value).slice(0, 60)}"`, availableOptions: optTexts.slice(0, 20) };
      }
      setReactValue(el, optTexts[idx]);
      highlightBox.style.outline = "2px solid #22c55e";
      return { ok: true, filledValue: `${optTexts[idx]} (dropdown)` };
    }

    // Close any previously open React-Select / listbox portal before opening this dropdown
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", keyCode: 27, bubbles: true }));
    await sleep(40);

    el.scrollIntoView({ block: "center" });
    el.focus?.();

    const container = el.closest(".select__container, .select-shell, [class*='combobox'], [class*='Combobox'], [class*='fieldEntry']") || el.parentElement;
    const flyoutBtn = container?.querySelector(".select__dropdown-indicator, button[aria-haspopup='listbox'], button[aria-label]");
    const reactCtrl = el.closest(".select__control, [class*='select__control']") || container?.querySelector(".select__control, [class*='select__control']");
    const triggerEl = flyoutBtn || reactCtrl || el;

    triggerEl.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, view: window }));
    triggerEl.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, view: window }));
    if (flyoutBtn || !reactCtrl) {
      triggerEl.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0, view: window }));
      triggerEl.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, view: window }));
    }

    let opts = [];
    for (let t = 0; t < 6; t++) {
      await sleep(50);
      opts = findVisibleDropdownOptions(el);
      if (opts.length > 0) break;
      if (t === 1) {
        el.focus?.();
        el.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", code: "ArrowDown", keyCode: 40, which: 40, bubbles: true, cancelable: true }));
      }
    }

    // 2. Search-driven autocomplete (e.g. Ashby Location "Start typing...")
    let typedSearch = false;
    if (opts.length === 0 && el.tagName === "INPUT") {
      const searchCandidates = [];
      const parts = cleanLabel(value).split(/[,/\-|]+/).map((p) => p.trim()).filter((p) => p.length >= 2);
      if (parts.length > 0) searchCandidates.push(parts[0]);
      if (parts.length > 1) searchCandidates.push(parts[parts.length - 1]);
      if (searchCandidates.length === 0 && value && String(value).length <= 40) {
        searchCandidates.push(String(value).trim());
      }

      for (const query of searchCandidates) {
        typedSearch = true;
        el.focus();
        setReactValue(el, query, true);
        for (let t = 0; t < 12; t++) {
          await sleep(100);
          opts = findVisibleDropdownOptions(el);
          if (opts.length > 0) break;
        }
        if (opts.length > 0) break;
      }
    }

    const optTexts = opts.map((o) => o.text);
    if (opts.length === 0) {
      if (typedSearch) setReactValue(el, "", true);
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", keyCode: 27, bubbles: true }));
      highlightBox.style.outline = "2px solid #f59e0b";
      return { ok: false, reason: "Could not read dropdown options — choose manually", availableOptions: [] };
    }

    const idx = pickBestOption(value, optTexts, fieldLabel);
    if (idx < 0) {
      if (typedSearch) setReactValue(el, "", true);
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", keyCode: 27, bubbles: true }));
      highlightBox.style.outline = "2px solid #f59e0b";
      return {
        ok: false,
        reason: `No dropdown option clearly matches "${String(value).slice(0, 60)}"`,
        availableOptions: optTexts.slice(0, 20),
      };
    }

    const picked = opts[idx];
    picked.el.scrollIntoView({ block: "nearest" });
    picked.el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, view: window }));
    picked.el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, view: window }));
    picked.el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0, view: window }));
    picked.el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, view: window }));
    await sleep(80);
    highlightBox.style.outline = "2px solid #22c55e";
    return { ok: true, filledValue: `${picked.text} (dropdown)` };
  }

  async function domFillField(fid, kind, value, fileData) {
    const els = [...document.querySelectorAll(`[data-careerops-fid="${CSS.escape(fid)}"]`)];
    if (els.length === 0) return { ok: false, reason: "element not found" };

    if ((kind === "file_resume" || kind === "file_cover") && fileData?.base64) {
      const input = els[0];
      const binary = atob(fileData.base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const file = new File([bytes], fileData.filename || "document.pdf", { type: "application/pdf" });
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.style.outline = "2px solid #22c55e";
      const kb = Math.max(1, Math.round(file.size / 1024));
      return { ok: true, filledValue: `${file.name} (${kb} KB attached)` };
    }

    if (kind === "radio" || kind === "checkbox_group") {
      const fieldLabel = extractFieldLabel(els[0]);
      const labels = els.map((r) => {
        const l = r.closest("label")?.innerText || document.querySelector(`label[for="${CSS.escape(r.id || '')}"]`)?.innerText || r.value || "";
        return cleanLabel(l);
      });
      const idx = pickBestOption(value, labels, fieldLabel);
      if (idx < 0) {
        els[0].closest("[role='radiogroup'], fieldset, .application-question")?.style &&
          (els[0].closest("[role='radiogroup'], fieldset, .application-question").style.outline = "2px solid #f59e0b");
        return { ok: false, reason: `no matching ${kind} option for "${value}"`, availableOptions: labels };
      }
      if (!els[idx].checked) els[idx].click();
      els[idx].dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true, filledValue: labels[idx] };
    }

    if (kind === "button_group") {
      const fieldLabel = extractFieldLabel(els[0]);
      const labels = els.map((b) => cleanLabel(b.innerText));
      const idx = pickBestOption(value, labels, fieldLabel);
      if (idx < 0) {
        els.forEach((b) => (b.style.outline = "2px solid #f59e0b"));
        return { ok: false, reason: `no matching button option for "${value}"`, availableOptions: labels };
      }
      els[idx].click();
      els[idx].style.outline = "2px solid #22c55e";
      return { ok: true, filledValue: labels[idx] };
    }

    const el = els[0];
    const fieldLabel = extractFieldLabel(el);

    if (kind === "select" || el.tagName === "SELECT") {
      const opts = [...el.options];
      const optTexts = opts.map((o) => cleanLabel(o.textContent));
      const idx = pickBestOption(value, optTexts, fieldLabel);
      if (idx < 0) {
        el.style.outline = "2px solid #f59e0b";
        return {
          ok: false,
          reason: `no matching select option for "${value}"`,
          availableOptions: optTexts.filter((t) => !isPlaceholderOption(t)),
        };
      }
      setReactValue(el, opts[idx].value);
      el.style.outline = "2px solid #22c55e";
      return { ok: true, filledValue: cleanLabel(opts[idx].textContent) };
    }

    // Never fall through to plain text typing on a dropdown / combobox control!
    if (kind === "combobox" || isDropdownInput(el)) {
      return await fillComboboxField(el, value, fieldLabel);
    }

    if (kind === "checkbox") {
      const wantCheck = /^(yes|true|checked|agree|confirm|consent)/i.test(String(value).trim());
      if (el.checked !== wantCheck) {
        el.click();
      }
      el.style.outline = "2px solid #22c55e";
      return { ok: true, filledValue: el.checked ? "checked" : "unchecked" };
    }

    setReactValue(el, String(value));
    el.style.outline = "2px solid #22c55e";
    return { ok: true, filledValue: String(value) };
  }

  function domHighlightNeedsInput(fids) {
    for (const fid of fids) {
      const el = document.querySelector(`[data-careerops-fid="${CSS.escape(fid)}"]`);
      if (!el) continue;
      const target = el.closest("[role='radiogroup'], fieldset") || el;
      target.style.outline = "2px solid #f59e0b";
    }
  }

  globalScope.CareerOpsMatcher = {
    normalizeText,
    cleanLabel,
    stripApplySuffix,
    urlCanonicalKeys,
    findMatchedItem,
    findInQaMemory,
    findInRoleAnswers,
    pickBestOption,
    resolveFieldPlan,
    isLinkedInHost,
    getLinkedInEasyApplyModalRoot,
    domExtractLinkedInJob,
    domScanAndResolve,
    domFillField,
    domHighlightNeedsInput,
  };
})(typeof globalThis !== "undefined" ? globalThis : window);
