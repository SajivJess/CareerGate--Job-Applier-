import fs from "node:fs";
import path from "node:path";
import { careerOpsRoot, readApplications } from "@/lib/career-ops";
import { canonicalJobKey } from "@/lib/core/url-key.mjs";
import { firstMarkdownLinkTarget } from "@/lib/posting-url.mjs";

export interface LaunchpadAnswer {
  question: string;
  answer: string;
  needsConfirm?: boolean;
}

export interface LaunchpadItem {
  num: number;
  numStr: string;
  trackerNum: string;
  trackerStatus: string;
  trackerDate: string;
  id: string;
  company: string;
  title: string;
  score: number;
  tier: number;
  tierLabel: string;
  track: string;
  trackPriority: number;
  region?: string;
  location: string;
  workAuth: string;
  comp: string;
  seniorityBar: string;
  summary: string;
  matchedProofPoints: string[];
  gapsBlockers: string[];
  ats: string;
  url: string;
  applyUrl: string;
  canonicalKey: string;
  duplicateElsewhereApplied: boolean;
  gmailAlias: string;
  cvPdfRel: string;
  coverPdfRel: string;
  cvPdfAbs: string;
  coverPdfAbs: string;
  coverText: string;
  reportRel: string;
  warnings: string[];
  answers: LaunchpadAnswer[];
}

const SUBMITTED_STATES = new Set([
  "applied",
  "responded",
  "assessment",
  "interview",
  "offer",
  "hired",
]);

/** Load enriched launchpad items merged with live status rows from data/applications.md. */
export function loadLaunchpadItems(): LaunchpadItem[] {
  const root = careerOpsRoot();
  const dataPath = path.join(root, "output", "_launchpad-data.json");
  if (!fs.existsSync(dataPath)) return [];

  let parsed: { items?: LaunchpadItem[] };
  try {
    parsed = JSON.parse(fs.readFileSync(dataPath, "utf8")) as { items?: LaunchpadItem[] };
  } catch {
    return [];
  }

  const rawItems = Array.isArray(parsed.items) ? parsed.items : [];
  const apps = readApplications();
  const byRow = new Map(apps.map((row) => [row.n.trim(), row]));
  const submittedUrlKeys = new Map<string, string>();

  for (const row of apps) {
    if (!SUBMITTED_STATES.has(row.status.trim().toLowerCase())) continue;
    const rawHref = firstMarkdownLinkTarget(row.url) || row.applyLink || row.url;
    const key = canonicalJobKey(rawHref);
    if (key) submittedUrlKeys.set(key, row.n.trim());
  }

  return rawItems.map((item) => {
    const tracker = byRow.get(String(item.trackerNum).trim());
    const liveStatus = tracker?.status?.trim() || item.trackerStatus || "Evaluated";
    const liveDate = tracker?.date?.trim() || item.trackerDate || "";
    const urlKey = canonicalJobKey(item.url || item.applyUrl);
    const matchingAppliedRow = urlKey ? submittedUrlKeys.get(urlKey) : undefined;
    const duplicateElsewhereApplied = Boolean(
      matchingAppliedRow && matchingAppliedRow !== String(item.trackerNum).trim(),
    );

    const inferredRegion =
      item.region ||
      (/bengaluru|bangalore|chennai|hyderabad|pune|mumbai|india/i.test(item.location)
        ? "India"
        : /germany|berlin|munich|münchen|leonberg|frankfurt|hamburg|stuttgart/i.test(item.location)
          ? "Germany"
          : "Foreign");

    return {
      ...item,
      region: inferredRegion,
      trackerStatus: liveStatus,
      trackerDate: liveDate,
      canonicalKey: urlKey,
      duplicateElsewhereApplied,
    };
  });
}

