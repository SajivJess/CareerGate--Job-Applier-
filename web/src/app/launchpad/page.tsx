import { PageFrame } from "@/components/page-frame";
import { LaunchpadClient } from "@/components/launchpad-client";
import { loadLaunchpadItems } from "@/lib/launchpad-data";

export const dynamic = "force-dynamic";

export default async function LaunchpadPage() {
  const items = loadLaunchpadItems();
  return (
    <PageFrame className="max-w-6xl">
      <LaunchpadClient initialItems={items} />
    </PageFrame>
  );
}

