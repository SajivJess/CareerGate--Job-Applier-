"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, Copy, ExternalLink, FileText, ShieldAlert } from "lucide-react";
import type { LaunchpadItem } from "@/lib/launchpad-data";
import { trackerSignatureFromLaunchpad, useTrackerLiveSync } from "@/lib/use-tracker-live-sync";
import { saveStatus, undoStatus } from "@/lib/pipeline-status.mjs";
import { appliedWriteAllowed } from "@/lib/applied-confirm.mjs";

const PROFILE_CHIPS: readonly [string, string][] = [
  ["First Name", "Sajiv"],
  ["Last Name", "Jess B I"],
  ["Full Name", "Sajiv Jess B I"],
  ["Phonetic", "Sah-jeev Jess"],
  ["Phone", "+91 7200599700"],
  ["City / Country", "Chennai, Tamil Nadu, India"],
  ["University", "Rajalakshmi Engineering College, Chennai (Anna University)"],
  ["Degree & CGPA", "B.Tech AI & ML | CGPA 7.28 / 10.0 | Expected May 2027"],
  ["LinkedIn", "https://www.linkedin.com/in/sajivjess/"],
  ["GitHub", "https://github.com/SajivJess"],
  ["Portfolio", "https://sajivjess.dev/"],
  ["Current Org", "Mahindra & Mahindra Ltd. (ADAS Research Intern) / Rajalakshmi Engineering College"],
];

const SUBMITTED_STATES = new Set([
  "applied",
  "responded",
  "assessment",
  "interview",
  "offer",
  "hired",
]);

function normalizeStatus(status: string): string {
  return status.trim().toLowerCase();
}

async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}

function CopyButton({
  text,
  label = "Copy",
  variant = "default",
  onCopied,
}: {
  text: string;
  label?: string;
  variant?: "default" | "accent" | "chip";
  onCopied?: (msg: string) => void;
}) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    const ok = await writeClipboard(text);
    if (ok) {
      setCopied(true);
      onCopied?.(`${label} ✓`);
      window.setTimeout(() => setCopied(false), 1600);
    }
  }

  const baseClass =
    variant === "chip"
      ? "inline-flex items-center gap-1.5 rounded-lg border border-border bg-background/70 px-2.5 py-1.5 text-xs text-foreground transition-colors hover:border-brand/50"
      : variant === "accent"
        ? "inline-flex items-center gap-1.5 rounded-lg border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5 text-xs font-medium text-amber-300 transition-colors hover:bg-amber-500/20"
        : "inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:border-brand/50 hover:text-brand-text";

  return (
    <button type="button" onClick={handleCopy} className={baseClass}>
      {copied ? <Check className="size-3.5 text-emerald-400" /> : <Copy className="size-3.5 text-muted" />}
      <span>{copied ? "Copied ✓" : label}</span>
    </button>
  );
}

export function LaunchpadClient({ initialItems }: { initialItems: LaunchpadItem[] }) {
  const router = useRouter();
  const [items, setItems] = useState<LaunchpadItem[]>(initialItems);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<string>("ready");
  const [regionFilter, setRegionFilter] = useState<string>("all");
  const [toast, setToast] = useState("");

  useEffect(() => {
    setItems(initialItems);
  }, [initialItems]);

  const currentSig = useMemo(() => trackerSignatureFromLaunchpad(items), [items]);

  useTrackerLiveSync({
    initialSignature: currentSig,
    onLaunchpadItems: (freshItems, prevSig, nextSig) => {
      if (prevSig && nextSig !== prevSig) {
        notify("Tracker synced → moved updated applications ✓");
      }
      setItems(freshItems);
      router.refresh();
    },
  });

  function notify(message: string) {
    setToast(message);
    window.setTimeout(() => setToast((cur) => (cur === message ? "" : cur)), 2200);
  }

  const stats = useMemo(() => {
    let applied = 0;
    let skipped = 0;
    let ready = 0;
    let indiaReady = 0;
    let germanyReady = 0;
    let foreignReady = 0;
    const companySubmittedCounts = new Map<string, number>();

    for (const item of items) {
      const st = normalizeStatus(item.trackerStatus);
      const reg = item.region || "Foreign";
      if (SUBMITTED_STATES.has(st)) {
        applied += 1;
        companySubmittedCounts.set(
          item.company,
          (companySubmittedCounts.get(item.company) ?? 0) + 1,
        );
      } else if (st === "skip" || st === "discarded" || st === "rejected") {
        skipped += 1;
      } else {
        ready += 1;
        if (reg === "India") indiaReady += 1;
        else if (reg === "Germany") germanyReady += 1;
        else foreignReady += 1;
      }
    }

    return { applied, skipped, ready, indiaReady, germanyReady, foreignReady, total: items.length, companySubmittedCounts };
  }, [items]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter((item) => {
      const st = normalizeStatus(item.trackerStatus);
      const isSubmitted = SUBMITTED_STATES.has(st) || item.duplicateElsewhereApplied;
      const isSkipped = st === "skip" || st === "discarded" || st === "rejected";

      if (filter === "ready" && (isSubmitted || isSkipped)) return false;
      if (filter === "applied" && !isSubmitted) return false;
      if (filter === "skipped" && !isSkipped) return false;
      if (filter === "t1" && (item.tier !== 1 || isSkipped)) return false;
      if (filter === "t2" && (item.tier !== 2 || isSkipped)) return false;
      if (filter === "t3" && (item.tier !== 3 || isSkipped)) return false;
      if (filter === "track1" && item.trackPriority !== 1) return false;
      if (regionFilter !== "all" && (item.region || "Foreign") !== regionFilter) return false;

      if (q) {
        const hay = [
          item.numStr,
          item.company,
          item.title,
          item.location,
          item.ats,
          item.track,
          item.summary,
          ...item.answers.map((a) => a.question),
        ]
          .join(" ")
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [items, search, filter, regionFilter]);

  function handleLocalStatusUpdate(trackerNum: string, nextStatus: string) {
    const today = new Date().toISOString().slice(0, 10);
    setItems((prev) =>
      prev.map((row) =>
        row.trackerNum === trackerNum ? { ...row, trackerStatus: nextStatus, trackerDate: today } : row,
      ),
    );
    router.refresh();
  }

  if (items.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-surface/40 p-6">
        <h1 className="font-display text-2xl text-landing">Apply Launchpad</h1>
        <p className="mt-2 text-sm text-muted">
          No launchpad manifest found at <code className="font-mono">output/_launchpad-data.json</code>.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <header className="rounded-2xl border border-border bg-surface/40 p-6">
        <p className="font-mono text-xs uppercase tracking-[0.18em] text-faint">Apply Launchpad &amp; Deduplicated Tracker</p>
        <h1 className="mt-1 font-display text-3xl tracking-tight text-landing">
          All {items.length} Tailored Applications (&gt; 3.0 Score)
        </h1>
        <p className="mt-2 max-w-3xl text-sm text-muted">
          Full job context, tailored Resume &amp; Cover Letter PDFs, one-click Cover Letter plain-text copy, and live-inspected
          portal answers with one-click Clipboard Copy. Marking a role <strong>Applied</strong> writes atomically to{" "}
          <code className="font-mono text-xs">data/applications.md</code> and locks duplicates out of your ready queue.
        </p>
      </header>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Ready Queue" value={stats.ready} tone="blue" />
        <StatCard label="Applied ✓ (Locked)" value={stats.applied} tone="green" />
        <StatCard label="Skipped" value={stats.skipped} tone="amber" />
        <StatCard label="Total Pool" value={stats.total} tone="neutral" />
      </div>

      <details open className="rounded-xl border border-border bg-surface/35 p-4">
        <summary className="cursor-pointer text-sm font-semibold text-foreground">
          Quick Profile Copy Strip (click any field to copy to clipboard)
        </summary>
        <div className="mt-3 flex flex-wrap gap-2">
          {PROFILE_CHIPS.map(([label, value]) => (
            <button
              key={label}
              type="button"
              onClick={async () => {
                if (await writeClipboard(value)) notify(`${label} copied ✓`);
              }}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background/70 px-2.5 py-1.5 text-left text-xs transition-colors hover:border-brand/50"
            >
              <strong className="text-brand-text">{label}:</strong>
              <span className="text-muted">{value}</span>
            </button>
          ))}
        </div>
      </details>

      <div className="sticky top-2 z-20 space-y-2 rounded-xl border border-border bg-background/95 p-3 shadow-lg backdrop-blur">
        <div className="flex flex-wrap items-center gap-1.5" role="tablist" aria-label="Application sections">
          {(
            [
              ["ready", `Pending / Ready (${stats.ready})`],
              ["applied", `Already Applied ✓ (${stats.applied})`],
              ["skipped", `Skipped (${stats.skipped})`],
              ["all", `All (${stats.total})`],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={filter === key}
              onClick={() => setFilter(key)}
              className={
                filter === key
                  ? "rounded-lg border border-brand bg-brand/15 px-3 py-1.5 text-xs font-semibold text-brand-text"
                  : "rounded-lg border border-border bg-surface/50 px-3 py-1.5 text-xs font-medium text-muted transition-colors hover:text-foreground"
              }
            >
              {label}
            </button>
          ))}
          <span className="mx-1 h-4 w-px bg-border" aria-hidden="true" />
          {(
            [
              ["all", "All Regions"],
              ["India", `India (${stats.indiaReady} pending)`],
              ["Germany", `Germany (${stats.germanyReady} pending)`],
              ["Foreign", `Foreign (${stats.foreignReady} pending)`],
            ] as const
          ).map(([regKey, regLabel]) => (
            <button
              key={regKey}
              type="button"
              onClick={() => setRegionFilter(regKey)}
              className={
                regionFilter === regKey
                  ? "rounded-lg border border-sky-500/60 bg-sky-500/15 px-2.5 py-1.5 text-xs font-semibold text-sky-300"
                  : "rounded-lg border border-border bg-surface/50 px-2.5 py-1.5 text-xs font-medium text-muted transition-colors hover:text-foreground"
              }
            >
              {regLabel}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2.5">
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search company, title, location, ATS, or form question..."
            className="min-w-[220px] flex-1 rounded-lg border border-border bg-surface/50 px-3 py-2 text-sm text-foreground placeholder:text-faint focus:border-brand focus:outline-none"
          />
          <select
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="rounded-lg border border-border bg-surface/50 px-3 py-2 text-sm text-foreground focus:border-brand focus:outline-none"
          >
            <option value="ready">Queue: Pending Applications ({stats.ready})</option>
            <option value="all">Show: All {stats.total} Roles</option>
            <option value="t1">Tier 1: Best New-Grad / Early-Career</option>
            <option value="t2">Tier 2: Solid Early / Mid Stretch</option>
            <option value="t3">Tier 3: Stretch / Caution</option>
            <option value="track1">Track 1: Automotive / ADAS</option>
            <option value="applied">Tracker: Already Applied ✓ ({stats.applied})</option>
            <option value="skipped">Tracker: Skipped ({stats.skipped})</option>
          </select>
          <Link
            href="/pipeline"
            className="rounded-lg border border-border bg-surface px-3 py-2 text-xs font-medium text-muted transition-colors hover:text-foreground"
          >
            Full Tracker Table
          </Link>
        </div>
      </div>

      <div className="space-y-4">
        {filtered.length === 0 ? (
          <div className="rounded-xl border border-border bg-surface/35 p-6 text-sm text-muted">
            No applications match the active filter.
          </div>
        ) : (
          filtered.map((item) => (
            <LaunchpadCard
              key={item.id}
              item={item}
              siblingAppliedCount={stats.companySubmittedCounts.get(item.company) ?? 0}
              onStatusSaved={handleLocalStatusUpdate}
              onNotify={notify}
            />
          ))
        )}
      </div>

      {toast ? (
        <div
          role="status"
          className="fixed bottom-5 right-5 z-50 rounded-lg border border-emerald-500/60 bg-emerald-950/95 px-4 py-2 text-xs font-semibold text-emerald-200 shadow-lg"
        >
          {toast}
        </div>
      ) : null}
    </div>
  );
}

function StatCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "blue" | "green" | "amber" | "neutral";
}) {
  const color =
    tone === "blue"
      ? "text-sky-400"
      : tone === "green"
        ? "text-emerald-400"
        : tone === "amber"
          ? "text-amber-400"
          : "text-foreground";
  return (
    <div className="rounded-xl border border-border bg-surface/40 px-4 py-3">
      <div className="text-[11px] font-medium uppercase tracking-wider text-faint">{label}</div>
      <div className={`mt-1 text-2xl font-bold ${color}`}>{value}</div>
    </div>
  );
}

function LaunchpadCard({
  item,
  siblingAppliedCount,
  onStatusSaved,
  onNotify,
}: {
  item: LaunchpadItem;
  siblingAppliedCount: number;
  onStatusSaved: (trackerNum: string, nextStatus: string) => void;
  onNotify: (msg: string) => void;
}) {
  const [confirmApply, setConfirmApply] = useState(false);
  const [busy, setBusy] = useState(false);
  const [followNote, setFollowNote] = useState("");
  const [error, setError] = useState("");

  const st = normalizeStatus(item.trackerStatus);
  const isApplied = SUBMITTED_STATES.has(st);
  const isSkipped = st === "skip" || st === "discarded" || st === "rejected";
  const pendingConfirm = appliedWriteAllowed({ status: "Applied", confirmed: false });
  const tierTone =
    item.tier === 1
      ? "border-emerald-500/35 bg-emerald-500/10 text-emerald-300"
      : item.tier === 2
        ? "border-sky-500/35 bg-sky-500/10 text-sky-300"
        : "border-amber-500/35 bg-amber-500/10 text-amber-300";

  async function markApplied() {
    if (busy || isApplied) return;
    setBusy(true);
    setError("");
    try {
      await saveStatus(item.trackerNum, item.trackerStatus, "Applied");
      setConfirmApply(false);
      onStatusSaved(item.trackerNum, "Applied");
      onNotify(`#${item.numStr} ${item.company} marked Applied ✓`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save Applied status.");
    } finally {
      setBusy(false);
    }
  }

  async function toggleSkip() {
    if (busy || isApplied) return;
    const next = isSkipped ? "Evaluated" : "SKIP";
    setBusy(true);
    setError("");
    try {
      await saveStatus(item.trackerNum, item.trackerStatus, next);
      onStatusSaved(item.trackerNum, next);
      onNotify(next === "SKIP" ? `#${item.numStr} skipped` : `#${item.numStr} restored to queue`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update status.");
    } finally {
      setBusy(false);
    }
  }

  async function handleUndo() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const restored = await undoStatus(item.trackerNum);
      onStatusSaved(item.trackerNum, restored);
      onNotify(`#${item.numStr} restored to ${restored}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not undo status.");
    } finally {
      setBusy(false);
    }
  }

  async function seedFollowup() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/followups/seed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ n: item.trackerNum }),
      });
      const body = (await res.json().catch(() => null)) as { error?: string; seeded?: boolean; reason?: string } | null;
      if (!res.ok) {
        setError(body?.error ?? "Could not seed follow-up.");
      } else {
        setFollowNote(
          body?.seeded !== false
            ? "Follow-up seeded ✓"
            : body?.reason === "disabled"
              ? "Follow-ups off in config"
              : "Already seeded",
        );
      }
    } catch {
      setError("Could not seed follow-up.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <article
      className={`rounded-xl border p-5 transition-opacity ${
        isApplied
          ? "border-emerald-600/50 bg-emerald-950/20"
          : isSkipped
            ? "border-dashed border-border bg-surface/20 opacity-60"
            : "border-border bg-surface/40"
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-md bg-brand-soft px-2 py-0.5 font-mono text-xs font-bold text-brand-text">
            #{item.numStr}
          </span>
          <h2 className="text-base font-bold text-foreground">
            {item.company} — {item.title}
          </h2>
          <span className="rounded-full border border-emerald-500/35 bg-emerald-500/15 px-2.5 py-0.5 text-xs font-semibold text-emerald-300">
            {item.score.toFixed(1)}/5
          </span>
          <span className={`rounded-full border px-2.5 py-0.5 text-xs font-medium ${tierTone}`}>
            Tier {item.tier}
          </span>
          <span className="rounded-full border border-sky-500/35 bg-sky-500/10 px-2.5 py-0.5 font-mono text-xs text-sky-300">
            {item.ats}
          </span>
          {item.region ? (
            <span className="rounded-full border border-amber-500/35 bg-amber-500/10 px-2.5 py-0.5 text-xs font-medium text-amber-200">
              {item.region}
            </span>
          ) : null}
          {isApplied ? (
            <span className="rounded-full bg-emerald-600 px-2.5 py-0.5 text-xs font-bold text-white">
              APPLIED ✓ {item.trackerDate}
            </span>
          ) : item.duplicateElsewhereApplied ? (
            <span className="inline-flex items-center gap-1 rounded-full border border-rose-500/50 bg-rose-500/15 px-2.5 py-0.5 text-xs font-semibold text-rose-300">
              <ShieldAlert className="size-3.5" /> Duplicate URL already Applied
            </span>
          ) : null}
          {!isApplied && siblingAppliedCount > 0 ? (
            <span className="rounded-full border border-violet-500/40 bg-violet-500/15 px-2.5 py-0.5 text-xs font-medium text-violet-200">
              {siblingAppliedCount} other {item.company} role(s) Applied
            </span>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {isApplied ? (
            <>
              <button
                type="button"
                disabled={busy}
                onClick={seedFollowup}
                className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-1.5 text-xs font-semibold text-emerald-300 hover:bg-emerald-500/20 disabled:opacity-50"
              >
                {followNote || "+ Seed Follow-up"}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={handleUndo}
                className="rounded-lg border border-border bg-surface px-3 py-1.5 text-xs font-medium text-muted hover:text-foreground disabled:opacity-50"
              >
                Undo Applied
              </button>
            </>
          ) : confirmApply ? (
            <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-emerald-500/40 bg-emerald-950/50 px-2.5 py-1">
              <span className="text-xs text-emerald-200">{pendingConfirm.prompt}</span>
              <button
                type="button"
                disabled={busy}
                onClick={markApplied}
                className="rounded bg-emerald-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
              >
                {busy ? "Saving…" : pendingConfirm.yesLabel}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => setConfirmApply(false)}
                className="px-2 py-1 text-xs text-muted hover:text-foreground"
              >
                Cancel
              </button>
            </div>
          ) : (
            <>
              <button
                type="button"
                disabled={busy || item.duplicateElsewhereApplied}
                onClick={() => setConfirmApply(true)}
                className="rounded-lg border border-emerald-500/50 bg-emerald-600/20 px-3 py-1.5 text-xs font-semibold text-emerald-200 hover:bg-emerald-600/35 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Mark Applied ✓
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={toggleSkip}
                className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-1.5 text-xs font-medium text-rose-200 hover:bg-rose-500/20 disabled:opacity-50"
              >
                {isSkipped ? "Restore" : "Skip"}
              </button>
            </>
          )}

          <CopyButton text={item.applyUrl} label="Copy URL" onCopied={onNotify} />
          <a
            href={item.applyUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-brand-foreground transition-opacity hover:opacity-90"
          >
            <span>{isApplied ? "Open Portal" : "Open Live Form"}</span>
            <ExternalLink className="size-3.5" />
          </a>
        </div>
      </div>

      {error ? <p className="mt-2 text-xs text-rose-400">{error}</p> : null}

      <div className="mt-3 grid gap-x-4 gap-y-1 text-xs text-muted sm:grid-cols-2 lg:grid-cols-3">
        <div><strong className="text-foreground">Track:</strong> {item.track}</div>
        <div><strong className="text-foreground">Location:</strong> {item.location}</div>
        <div><strong className="text-foreground">Work Auth:</strong> {item.workAuth}</div>
        <div><strong className="text-foreground">Comp:</strong> {item.comp}</div>
        <div><strong className="text-foreground">Role Bar:</strong> {item.seniorityBar || "Standard"}</div>
        <div>
          <strong className="text-foreground">Full Report:</strong>{" "}
          <Link href={`/pipeline/${encodeURIComponent(item.trackerNum)}`} className="text-brand-text hover:underline">
            Tracker Row #{item.trackerNum}
          </Link>
        </div>
      </div>

      <div className="mt-3 space-y-1 rounded-lg border border-border bg-background/50 p-3 text-xs">
        <div className="text-foreground"><strong>Fit Summary:</strong> {item.summary}</div>
        {item.matchedProofPoints.length > 0 ? (
          <div className="text-emerald-300/90">
            <strong>Matches:</strong> {item.matchedProofPoints.join(" • ")}
          </div>
        ) : null}
        {item.gapsBlockers.length > 0 ? (
          <div className="text-amber-300/90">
            <strong>Cautions / Verification:</strong> {item.gapsBlockers.join(" • ")}
          </div>
        ) : null}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-background/70 p-2.5 text-xs">
        <span className="text-muted">
          <strong className="text-foreground">Portal Email:</strong>{" "}
          <code className="font-mono text-brand-text">{item.gmailAlias}</code>
        </span>
        <CopyButton text={item.gmailAlias} label="Copy Email" onCopied={onNotify} />

        <a
          href={`/api/cv-pdf?n=${item.num}`}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs font-medium text-foreground hover:border-brand/50"
        >
          <FileText className="size-3.5 text-sky-400" /> View CV PDF
        </a>
        <CopyButton text={item.cvPdfAbs} label="Copy CV Path" onCopied={onNotify} />

        <a
          href={`/api/cv-pdf?n=${item.num}&kind=cover`}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs font-medium text-foreground hover:border-brand/50"
        >
          <FileText className="size-3.5 text-amber-400" /> View Cover PDF
        </a>
        <CopyButton text={item.coverPdfAbs} label="Copy Cover Path" onCopied={onNotify} />

        {item.coverText ? (
          <CopyButton
            text={item.coverText}
            label="Copy Cover Letter Text"
            variant="accent"
            onCopied={onNotify}
          />
        ) : null}
      </div>

      {item.warnings.length > 0 ? (
        <div className="mt-2.5 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-200">
          <strong>Pre-Submit Check Warnings:</strong>
          <ul className="mt-1 list-disc pl-4">
            {item.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {item.coverText ? (
        <details className="mt-2.5 rounded-lg border border-border bg-background/45 px-3 py-2">
          <summary className="cursor-pointer text-xs font-semibold text-sky-300">
            Cover Letter Plain-Text Preview (or click &quot;Copy Cover Letter Text&quot; above)
          </summary>
          <pre className="mt-2 whitespace-pre-wrap rounded-md border border-border bg-background/80 p-3 font-sans text-xs text-muted">
            {item.coverText}
          </pre>
        </details>
      ) : null}

      <details className="mt-2.5 rounded-lg border border-border bg-background/45 px-3 py-2">
        <summary className="cursor-pointer text-xs font-semibold text-sky-300">
          Portal Form Questions &amp; Ready-to-Paste Answers ({item.answers.length} fields)
        </summary>
        <div className="mt-2 divide-y divide-border/60">
          {item.answers.map((qa, idx) => (
            <div key={`${qa.question}:${idx}`} className="py-2.5 first:pt-1 last:pb-1">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-semibold text-foreground">
                  {qa.question}
                  {qa.needsConfirm ? (
                    <span className="ml-2 rounded bg-amber-500/20 px-1.5 py-0.5 text-[11px] font-medium text-amber-300">
                      Confirm personally
                    </span>
                  ) : null}
                </span>
                <CopyButton text={qa.answer} label="Copy Answer" onCopied={onNotify} />
              </div>
              <pre
                className={`mt-1.5 whitespace-pre-wrap rounded-md border p-2 font-sans text-xs ${
                  qa.needsConfirm
                    ? "border-amber-500/45 bg-amber-500/5 text-amber-100"
                    : "border-border bg-background/80 text-muted"
                }`}
              >
                {qa.answer}
              </pre>
            </div>
          ))}
        </div>
      </details>
    </article>
  );
}

