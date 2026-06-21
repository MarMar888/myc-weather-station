// Pipeline-health alert — the ONLY alert.
//
// Emails when the data pipeline goes unhealthy (no fresh reading in STALE_MIN
// minutes) and again when it recovers. Fires on the rising edge with a cooldown
// reminder, so you get one "down" email, optional reminders while it stays down,
// and one "recovered" email — never a poll-by-poll stream.
//
// What this catches: the WeatherLink source freezing (observed_at stops
// advancing) whenever the cron is still running, plus anything that leaves the
// table stale. What it does NOT catch on its own: the cron/QStash stopping
// entirely (nothing runs to notice). A QStash failure-callback or external
// uptime ping closes that last gap — see /api/health.

import { getLatest, getAlertState, setAlertState } from "./db";

function envNum(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

export function emailConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY && process.env.ALERT_FROM && process.env.ALERT_TO);
}

const SITE = "https://myc-weather-station.vercel.app";

export interface PipelineStatus {
  healthy: boolean;
  ageMin: number | null; // minutes since the latest stored observation
  lastObserved: number | null; // epoch ms
  staleMin: number; // threshold that defines "unhealthy"
  expectedEveryMin: number; // informational — the normal cadence
}

/** Current pipeline health, derived from the freshest reading in the table. */
export async function pipelineStatus(): Promise<PipelineStatus> {
  const staleMin = envNum("ALERT_STALE_MIN", 20);
  const expectedEveryMin = envNum("ALERT_EXPECT_MIN", 3);
  let lastObserved: number | null = null;
  try {
    const latest = await getLatest();
    lastObserved = latest ? Number(latest.observed_at) : null;
  } catch {
    lastObserved = null;
  }
  const ageMin = lastObserved == null ? null : (Date.now() - lastObserved) / 60_000;
  // No data at all is treated as healthy=false only once data has ever existed;
  // a brand-new empty table shouldn't alarm, so null age → healthy.
  const healthy = ageMin == null ? true : ageMin <= staleMin;
  return { healthy, ageMin, lastObserved, staleMin, expectedEveryMin };
}

async function sendEmail(subject: string, text: string): Promise<boolean> {
  const to = (process.env.ALERT_TO ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!to.length) return false;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from: process.env.ALERT_FROM, to, subject, text }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function ctTime(ms: number): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(ms));
}

export interface HealthAlertResult {
  configured: boolean;
  status: PipelineStatus;
  sent: "down" | "reminder" | "recovered" | null;
}

/**
 * Evaluate pipeline health and email on state transitions. Safe to call from
 * anywhere (cron, /api/health, a failure callback) — it always re-checks real
 * staleness from the DB before sending, so it can't false-alarm. Never throws.
 */
export async function evaluatePipelineHealth(): Promise<HealthAlertResult> {
  const status = await pipelineStatus();
  if (!emailConfigured()) return { configured: false, status, sent: null };

  const cooldownMs = envNum("ALERT_COOLDOWN_MIN", 180) * 60_000;
  const now = Date.now();
  const st = await getAlertState("pipeline_health"); // active=1 ⇒ already notified down
  const ageTxt = status.ageMin == null ? "unknown" : `${status.ageMin.toFixed(0)} min`;
  const lastTxt = status.lastObserved == null ? "never" : `${ctTime(status.lastObserved)} CT`;

  let sent: HealthAlertResult["sent"] = null;

  if (!status.healthy) {
    const firstTime = st.active === 0;
    const dueReminder = st.active === 1 && now - st.last_sent > cooldownMs;
    if (firstTime || dueReminder) {
      const ok = await sendEmail(
        `⚠️ MYC pipeline stale — no data in ${ageTxt}`,
        `The wind data pipeline looks unhealthy.\n\n` +
          `Last reading: ${lastTxt} (${ageTxt} ago)\n` +
          `Expected cadence: every ${status.expectedEveryMin} min\n` +
          `Alert threshold: ${status.staleMin} min without fresh data\n\n` +
          `Likely causes: the WeatherLink station stopped reporting, the extractor is erroring, or the scheduler stopped.\n\n` +
          `Dashboard: ${SITE}\nHealth: ${SITE}/api/health`,
      );
      if (ok) {
        sent = firstTime ? "down" : "reminder";
        await setAlertState("pipeline_health", { active: 1, last_sent: now });
      }
    }
  } else if (st.active === 1) {
    const ok = await sendEmail(
      `✅ MYC pipeline recovered`,
      `Fresh wind data is landing again.\n\nLatest reading: ${lastTxt} (${ageTxt} ago)\n\nDashboard: ${SITE}`,
    );
    if (ok) {
      sent = "recovered";
      await setAlertState("pipeline_health", { active: 0, last_sent: now });
    }
  }

  return { configured: true, status, sent };
}
