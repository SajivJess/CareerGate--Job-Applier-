import { spawn } from "node:child_process";
import fs from "node:fs";
import { rootScript } from "@/lib/career-ops";
import { resolveCodeRoot } from "@/lib/core/code-root.mjs";
import { readJsonObject } from "@/lib/json-body";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type PrepareResult = {
  ok: boolean;
  alreadyExisted?: boolean;
  needsJd?: boolean;
  num?: number;
  numStr?: string;
  item?: unknown;
  cvPdfRel?: string;
  coverPdfRel?: string;
  reportRel?: string;
  message?: string;
  error?: string;
};

function runPrepare(payload: Record<string, unknown>): Promise<{ code: number; result: PrepareResult }> {
  const script = rootScript("prepare-linkedin-job");
  if (!fs.existsSync(script)) {
    return Promise.resolve({
      code: 1,
      result: { ok: false, error: "prepare-linkedin-job.mjs is missing in career-ops root" },
    });
  }

  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, "--json"], {
      cwd: resolveCodeRoot(process.cwd(), process.env),
      env: process.env,
      windowsHide: true,
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      err += chunk.toString();
    });
    const killer = setTimeout(() => child.kill("SIGTERM"), 60_000);

    child.on("error", (e) => {
      clearTimeout(killer);
      resolve({ code: 1, result: { ok: false, error: e.message || "spawn failed" } });
    });
    child.stdin.on("error", () => {});
    child.on("close", (code) => {
      clearTimeout(killer);
      const lines = out
        .trim()
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i--) {
        if (lines[i].startsWith("{")) {
          try {
            const parsed = JSON.parse(lines[i]) as PrepareResult;
            resolve({ code: code ?? 1, result: parsed });
            return;
          } catch {}
        }
      }
      resolve({
        code: code ?? 1,
        result: {
          ok: false,
          error: err.trim() || out.trim() || `prepare-linkedin-job exited with code ${code ?? 1}`,
        },
      });
    });
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

export async function POST(req: Request) {
  const body = await readJsonObject<{
    url?: unknown;
    jobId?: unknown;
    title?: unknown;
    company?: unknown;
    location?: unknown;
    jdText?: unknown;
    manualJdText?: unknown;
    status?: unknown;
  }>(req);

  if (!body) {
    return Response.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const url = typeof body.url === "string" ? body.url.trim() : "";
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const company = typeof body.company === "string" ? body.company.trim() : "";
  if (!url || !title || !company) {
    return Response.json(
      { ok: false, error: "url, company, and title are required to prepare a LinkedIn role" },
      { status: 400 },
    );
  }

  const { result } = await runPrepare(body);
  if (!result.ok) {
    const status = result.needsJd ? 422 : 500;
    return Response.json(result, { status });
  }
  return Response.json(result, { status: 200 });
}
