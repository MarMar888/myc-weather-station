import { NextRequest, NextResponse } from "next/server";
import { pipelineStatus, evaluatePipelineHealth } from "@/lib/alerts";

// Always live — reflects current DB freshness.
export const dynamic = "force-dynamic";

// GET /api/health            → read-only status (safe to expose / poll from UI)
// GET /api/health?notify=1   → also runs the email check (rising-edge + cooldown).
//   The notify path is the target for a QStash failure-callback or an external
//   uptime monitor. The email logic re-verifies real staleness from the DB, so
//   calling it can never produce a false alarm even if left unguarded; we still
//   require the bearer secret (when set) before doing the side-effecting check.
async function handle(req: NextRequest) {
  const notify = req.nextUrl.searchParams.get("notify") === "1";
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization");
  const authorized = !secret || auth === `Bearer ${secret}`;

  if (notify && authorized) {
    const result = await evaluatePipelineHealth().catch(() => null);
    const healthy = result?.status.healthy ?? true;
    return NextResponse.json(
      { ...(result ?? { configured: false }), notified: true },
      { status: healthy ? 200 : 503 },
    );
  }

  const status = await pipelineStatus();
  return NextResponse.json(
    { configured: undefined, status, notified: false },
    { status: status.healthy ? 200 : 503 },
  );
}

export async function GET(req: NextRequest) {
  return handle(req);
}

export async function POST(req: NextRequest) {
  return handle(req);
}
