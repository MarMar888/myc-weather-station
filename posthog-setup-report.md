# PostHog post-wizard report

The wizard has completed a deep integration of PostHog analytics into the MYC Weather Station project. Client-side tracking was added to the main dashboard page and the oscillation view component, capturing all meaningful user interactions. A server-side PostHog client was created and wired into the cron route to track every successful weather reading ingestion. PostHog is initialized via `instrumentation-client.ts` (the Next.js 15.3+ pattern), with a reverse proxy configured in `next.config.ts` to route events through `/ingest`.

| Event | Description | File |
|---|---|---|
| `wind_unit_changed` | User switches the wind speed display unit between knots and mph. | `src/app/page.tsx` |
| `time_range_changed` | User selects a preset time range (3h, 6h, 24h, 7d, 30d) for the history chart. | `src/app/page.tsx` |
| `custom_range_applied` | User applies a custom time range via the custom range modal. | `src/app/page.tsx` |
| `tab_changed` | User switches between the Live and Oscillation dashboard tabs. | `src/app/page.tsx` |
| `feature_request_submitted` | User submits a feature request via the feature request modal. | `src/app/page.tsx` |
| `oscillation_mode_changed` | User changes the oscillation analysis lens (regimes, 30m, 1h, day). | `src/components/oscillation-view.tsx` |
| `regime_selected` | User clicks on a wind regime segment in the oscillation timeline. | `src/components/oscillation-view.tsx` |
| `weather_reading_recorded` | Cron job successfully records a new weather reading to the database. | `src/app/api/cron/route.ts` |

## Next steps

We've built some insights and a dashboard for you to keep an eye on user behavior, based on the events we just instrumented:

- [Analytics basics (wizard) — Dashboard](https://us.posthog.com/project/479522/dashboard/1740649)
- [User engagement over time](https://us.posthog.com/project/479522/insights/pR9Xa7RE)
- [Feature requests submitted](https://us.posthog.com/project/479522/insights/hXxi5Ew0)
- [Wind unit preference](https://us.posthog.com/project/479522/insights/2NSUW2Nw)
- [Oscillation analysis mode usage](https://us.posthog.com/project/479522/insights/Ey9EdCkQ)
- [Weather readings recorded](https://us.posthog.com/project/479522/insights/KopDegZD)

## Verify before merging

- [ ] Run a full production build (`pnpm build`) and fix any lint or type errors introduced by the generated code.
- [ ] Run the test suite — call sites that were rewritten or instrumented may need updated mocks or fixtures.
- [ ] Add `NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN` and `NEXT_PUBLIC_POSTHOG_HOST` to `.env.example` and any monorepo/bootstrap scripts so collaborators know what to set. Also add these to the Vercel environment variables for the production deployment.
- [ ] Wire source-map upload (`posthog-cli sourcemap` or your bundler's upload step) into CI so production stack traces de-minify.

### Agent skill

We've left an agent skill folder in your project. You can use this context for further agent development when using Claude Code. This will help ensure the model provides the most up-to-date approaches for integrating PostHog.
