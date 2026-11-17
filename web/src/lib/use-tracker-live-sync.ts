"use client";

import { useEffect, useRef } from "react";
import type { LaunchpadItem } from "@/lib/launchpad-data";

export function trackerSignatureFromLaunchpad(items: Pick<LaunchpadItem, "trackerNum" | "trackerStatus" | "trackerDate" | "duplicateElsewhereApplied">[]): string {
  return items
    .map((x) => `${x.trackerNum}:${x.trackerStatus}:${x.trackerDate}:${x.duplicateElsewhereApplied ? 1 : 0}`)
    .join("|");
}

/**
 * Keep client views synchronized with external tracker writes (such as the
 * Chrome Extension clicking Submitted/Applied) via custom event, focus, visibility,
 * and lightweight polling while the tab is visible.
 */
export function useTrackerLiveSync({
  initialSignature,
  pollMs = 3500,
  onLaunchpadItems,
  onTrackerChanged,
}: {
  initialSignature?: string;
  pollMs?: number;
  onLaunchpadItems?: (items: LaunchpadItem[], prevSignature: string, nextSignature: string) => void;
  onTrackerChanged?: () => void;
}) {
  const sigRef = useRef<string>(initialSignature ?? "");
  const inFlightRef = useRef(false);
  const onItemsRef = useRef(onLaunchpadItems);
  const onChangedRef = useRef(onTrackerChanged);

  useEffect(() => {
    onItemsRef.current = onLaunchpadItems;
  }, [onLaunchpadItems]);

  useEffect(() => {
    onChangedRef.current = onTrackerChanged;
  }, [onTrackerChanged]);

  useEffect(() => {
    if (initialSignature) {
      sigRef.current = initialSignature;
    }
  }, [initialSignature]);

  useEffect(() => {
    let cancelled = false;

    async function check(forceNotify = false) {
      if (cancelled || inFlightRef.current) return;
      inFlightRef.current = true;
      try {
        const res = await fetch("/api/launchpad", { cache: "no-store" });
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as { items?: LaunchpadItem[] };
        const freshItems = Array.isArray(data.items) ? data.items : null;
        if (!freshItems || cancelled) return;
        const nextSig = trackerSignatureFromLaunchpad(freshItems);
        const prevSig = sigRef.current;
        if (!prevSig && !forceNotify) {
          sigRef.current = nextSig;
          return;
        }
        if (forceNotify || nextSig !== prevSig) {
          sigRef.current = nextSig;
          if (onItemsRef.current && nextSig !== prevSig) {
            onItemsRef.current(freshItems, prevSig, nextSig);
          } else if (forceNotify && onItemsRef.current) {
            onItemsRef.current(freshItems, prevSig, nextSig);
          }
          onChangedRef.current?.();
        }
      } catch {
        // Ignore transient offline/server restart blips
      } finally {
        inFlightRef.current = false;
      }
    }

    const onEventSync = () => {
      void check(true);
    };
    const onFocus = () => {
      void check(false);
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") void check(false);
    };

    window.addEventListener("co-job-done", onEventSync);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);

    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") {
        void check(false);
      }
    }, pollMs);

    return () => {
      cancelled = true;
      window.removeEventListener("co-job-done", onEventSync);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
      window.clearInterval(timer);
    };
  }, [pollMs]);
}

