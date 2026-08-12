# Public shareable results link — design

**Date:** 2026-08-12
**Branch:** `feature/public-results-link`

## Goal

Let a round's results be published as a public link that anyone — including
people with no Usernode account — can open and read.

## Context

- `GET /api/results?round=<slug>` (issues #37/#39) is already **public and
  unauthenticated** for every `audience = 'everyone'` round, and intentionally
  exposes the live tally at any status. Invite-only and unknown rounds both
  404 so private rounds never leak.
- The HTML shell, however, is auth-gated: an unauthenticated visit to any page
  shows the "Open in Usernode" landing. So today there is public *data* but no
  public *page* — a shared link is unreadable for humans.

## Decisions

1. **No `results_published` flag.** The tallies of every public round are
   already exposed by `/api/results`; a flag would gate only the page while
   the JSON stayed open — security theater. "Publishing" is the act of
   sharing the link. Invite-only rounds remain unshareable (the API 404s
   them), same privacy rule as every other public endpoint.
2. **Standalone public page at `GET /results/:slug`.** A dedicated Express
   route (before the auth-gated catch-all) serves `public/results.html`
   without authentication — a GET outside `/api/` already passes the auth
   middleware, mirroring how static assets are treated. The page is a small
   read-only client renderer over `/api/results?round=<slug>`:
   - round title, description, status badge, creator, vote-rule summary;
   - "final results" (closed) vs "live tally — voting still open" (open/draft)
     labelling, so a partial count is never mistaken for a final one;
   - voter count, total votes, ranked per-app bars with medals (same visual
     language as the in-app results panel);
   - API 404 → friendly "round not found or not public" state; errors render
     in the DOM, never via `console.error` (a console error on any route
     fails proposal checks).
3. **In-app share affordance.** On the round detail view of every `everyone`
   round, a "🔗 Copy public results link" control shows
   `<location.origin>/results/<slug>` and copies it to the clipboard
   (`navigator.clipboard` with a `execCommand('copy')` fallback — the app
   runs in an iframe where clipboard permission isn't guaranteed; the URL is
   also displayed in a selectable input as the last resort).

## Alternatives considered

- **Chromeless platform deep link** (`#app/<slug>/full?path=…`): still routes
  viewers through the platform shell, so "visible by everyone" depends on
  platform auth. Rejected as the primary link; the app-origin page is
  genuinely public.
- **Publish/unpublish toggle + flag column**: rejected (decision 1) — it
  can't actually make the data private while `/api/results` exists, and the
  existing API contract (external admin tools poll it) shouldn't be broken.

## Testing

- `dapp.json` gains declared tests: `/results/staging-best-game` renders the
  closed round's results, and `/results/nonexistent` renders the not-found
  state (both client-rendered, like the existing page tests).
- Local smoke test: run the server in staging mode against a disposable
  Postgres, then fetch `/results/<seeded slug>` unauthenticated and confirm
  200 + page markup, and confirm `/api/results` still behaves.
