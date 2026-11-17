import { loadLaunchpadItems } from "@/lib/launchpad-data";
import { readQaMemory } from "@/lib/qa-memory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BASE_PROFILE = {
  firstName: "Sajiv",
  lastName: "Jess B I",
  fullName: "Sajiv Jess B I",
  phoneticName: "Sah-jeev Jess",
  pronouns: "He/him",
  baseEmail: "sajiv2580@gmail.com",
  phone: "+91 7200599700",
  location: "Chennai, Tamil Nadu, India",
  city: "Chennai",
  state: "Tamil Nadu",
  country: "India",
  currentCompany: "Mahindra & Mahindra Ltd. (ADAS Research Intern) / Rajalakshmi Engineering College",
  university: "Rajalakshmi Engineering College, Chennai (Anna University)",
  degree: "B.Tech in Artificial Intelligence and Machine Learning",
  cgpa: "7.28",
  graduation: "May 2027",
  linkedin: "https://www.linkedin.com/in/sajivjess/",
  github: "https://github.com/SajivJess",
  githubUsername: "SajivJess",
  portfolio: "https://sajivjess.dev/",
  languages: "English (fluent), Tamil (native), Hindi (reading), Malayalam (understanding)",
};

export async function GET() {
  const items = loadLaunchpadItems();
  const qaMemory = readQaMemory();
  return Response.json({
    items,
    profile: BASE_PROFILE,
    qaMemory,
  });
}

