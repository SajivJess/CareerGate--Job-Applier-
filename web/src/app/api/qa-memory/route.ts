import { NextRequest } from "next/server";
import { deleteQaMemory, readQaMemory, upsertQaMemory } from "@/lib/qa-memory";
import { readJsonObject } from "@/lib/json-body";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(readQaMemory());
}

export async function POST(req: NextRequest) {
  const body = await readJsonObject<{
    question?: string;
    answer?: string;
    fieldType?: string;
    alsoRememberFact?: boolean;
  }>(req);
  if (!body) return Response.json({ error: "bad json" }, { status: 400 });

  const question = typeof body.question === "string" ? body.question : "";
  const answer = typeof body.answer === "string" ? body.answer : "";
  if (!question.trim() || !answer.trim()) {
    return Response.json({ error: "question and answer required" }, { status: 400 });
  }

  try {
    const result = upsertQaMemory({
      question,
      answer,
      fieldType: typeof body.fieldType === "string" ? body.fieldType : "text",
      alsoRememberFact: body.alsoRememberFact === true,
    });
    return Response.json({ ok: true, ...result });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "could not save Q&A memory" },
      { status: 500 },
    );
  }
}

export async function DELETE(req: NextRequest) {
  let key = (req.nextUrl.searchParams.get("key") ?? "").trim();
  if (!key) {
    const body = await readJsonObject<{ key?: string; question?: string }>(req);
    key = (body?.key ?? body?.question ?? "").trim();
  }
  if (!key) return Response.json({ error: "key required" }, { status: 400 });

  const result = deleteQaMemory(key);
  return Response.json({ ok: true, ...result });
}

