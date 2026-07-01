const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

const app = express();
const port = process.env.PORT || 3000;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET;
const IS_STAGING = process.env.USERNODE_ENV === 'staging';

// Paths that stay open without authentication. Add a path here (and add it
// with `app.get`/`app.post` below) if you deliberately want it public.
// Everything else requires a valid platform-issued JWT.
const PUBLIC_API_PATHS = new Set(['/health', '/api/leaderboard']);
const PUBLIC_PREFIXES = ['/explorer-api/'];

app.use(express.json());

// Verify platform-issued JWT if one was passed, then enforce auth on
// anything not explicitly marked public. The iframe adds `?token=…`
// on load; the frontend script forwards the token via `x-usernode-token`
// on subsequent fetches.
app.use((req, res, next) => {
  const token = req.query.token || req.headers['x-usernode-token'];
  if (token && JWT_SECRET) {
    try { req.user = jwt.verify(token, JWT_SECRET); } catch {}
  }

  // Static assets (CSS/JS/images) are always served; the API and the HTML
  // shell are gated so direct hits to the staging/prod subdomain don't
  // leak app data to the public internet.
  if (req.method !== 'GET' || req.path.startsWith('/api/')) {
    if (PUBLIC_API_PATHS.has(req.path)) return next();
    if (PUBLIC_PREFIXES.some((p) => req.path.startsWith(p))) return next();
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
});

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// Favicon: browsers auto-request /favicon.ico on every page. Without an
// explicit handler it falls through express.static (no file) to the
// auth-gated HTML catch-all below, which 401s for the tokenless browser
// request — surfacing a console error that fails the no-console-errors CI
// baseline on every route. Answer with 204 No Content (no auth) so the
// request resolves cleanly with no asset to decode. Placed before the
// catch-all and never gated.
app.get('/favicon.ico', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=86400');
  res.status(204).end();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const norm = (s) => (s == null ? '' : String(s).trim().toLowerCase());

// Admin allowlist: usernames configured via the ADMIN_USERNAMES secret
// (comma/space separated), parsed once at startup into a normalized Set so
// lookups are case-insensitive. Empty by default → no admins in production.
const ADMIN_USERNAMES = new Set(
  String(process.env.ADMIN_USERNAMES || '')
    .split(/[\s,]+/)
    .map(norm)
    .filter(Boolean)
);

// Who is an admin: anyone on the allowlist, plus everyone in staging so the
// destructive delete affordance is exercisable against seeded fake data.
function isAdmin(user) {
  if (!user) return false;
  if (IS_STAGING) return true;
  return ADMIN_USERNAMES.has(norm(user.username));
}

// Platform public app directory — source of candidate apps + their
// contributors. Snapshotted into a round at creation time.
const APPS_DIRECTORY_URL = 'https://social-vibecoding.usernodelabs.org/api/public/apps';

// Obviously-fake fallback apps so the create-form picker is still usable in
// staging when the live directory can't be reached (staging has no
// guaranteed outbound). Never used in production. Contributor user_ids here
// line up with the staging seed makers below.
const STAGING_FALLBACK_APPS = [
  { id: 990001, name: 'Staging demo App Alpha',   slug: 'staging-demo-alpha',
    contributors: [{ user_id: 900101, username: 'staging-demo-maker-1', wallet_address: null }] },
  { id: 990002, name: 'Staging demo App Bravo',   slug: 'staging-demo-bravo',
    contributors: [{ user_id: 900102, username: 'staging-demo-maker-2', wallet_address: null }] },
  { id: 990003, name: 'Staging demo App Charlie', slug: 'staging-demo-charlie',
    contributors: [{ user_id: 900103, username: 'staging-demo-maker-3', wallet_address: null }] },
  { id: 990004, name: 'Staging demo App Delta',   slug: 'staging-demo-delta',
    contributors: [{ user_id: 900104, username: 'staging-demo-maker-4', wallet_address: null }] },
];

// Fetch the platform's public app directory. Throws on timeout / non-2xx /
// network error so callers can surface "directory unreachable"; in staging
// callers may fall back to STAGING_FALLBACK_APPS.
async function fetchDirectoryApps() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(APPS_DIRECTORY_URL, { signal: controller.signal });
    if (!res.ok) throw new Error(`directory responded ${res.status}`);
    const data = await res.json();
    return Array.isArray(data && data.apps) ? data.apps : [];
  } finally {
    clearTimeout(timer);
  }
}

// Build a viewable link for a directory app from its slug (or null).
function appUrlFromSlug(slug) {
  return slug ? `https://social-vibecoding.usernodelabs.org/#app/${slug}` : null;
}

// Platform-wide per-user leaderboard. `active_apps[].slug` are the apps each
// user has tested/used; `address` (ut1…) lines up with req.user.usernode_pubkey
// and `user_id` with req.user.id. Used to gate voting on require_tested_all
// rounds.
const LEADERBOARD_URL =
  'https://social-vibecoding.usernodelabs.org/api/leaderboard/users?include_0_values=0&fields=active_apps,address,user_id';

// Obviously-fake leaderboard used ONLY in staging when the live API can't be
// reached (staging has no guaranteed outbound). Never used in production. The
// seeded staging tester deliberately does NOT appear here, so a restricted
// round blocks them and the disclaimer renders without any live API. The
// ?demo=1 pass path (see checkTestedAll) is how a tester exercises the
// eligible branch.
const STAGING_FALLBACK_LEADERBOARD = [
  { username: 'staging-demo-voter-1', user_id: 910001, address: 'ut1stagingdemovoter1',
    active_apps: [{ name: 'Staging demo App Alpha', slug: 'staging-demo-alpha' }] },
  { username: 'staging-demo-voter-2', user_id: 910002, address: 'ut1stagingdemovoter2',
    active_apps: [
      { name: 'Staging demo App Alpha', slug: 'staging-demo-alpha' },
      { name: 'Staging demo App Bravo', slug: 'staging-demo-bravo' },
    ] },
];

// Fetch the platform leaderboard. Throws on timeout / non-2xx / network error
// so callers can surface "couldn't verify"; in staging callers may fall back
// to STAGING_FALLBACK_LEADERBOARD.
async function fetchLeaderboard() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(LEADERBOARD_URL, { signal: controller.signal });
    if (!res.ok) throw new Error(`leaderboard responded ${res.status}`);
    const data = await res.json();
    // Be tolerant of the feed's exact envelope. A healthy response keyed
    // differently than we expect must not collapse to [] (which would make
    // every voter look "unverifiable / blocked"). Accept the common shapes.
    if (Array.isArray(data)) return data;
    if (data && Array.isArray(data.items)) return data.items;
    if (data && Array.isArray(data.users)) return data.users;
    if (data && Array.isArray(data.leaderboard)) return data.leaderboard;
    return [];
  } finally {
    clearTimeout(timer);
  }
}

// Eligibility check for require_tested_all rounds. `requiredCands` is the set
// of ENFORCEABLE candidates (those carrying an app_slug) as `{ slug, name }`
// pairs. Returns a structured result; never throws. Defaults to BLOCKING
// (eligible:false) on every failure mode rather than silently allowing.
//   { eligible, missing: [slug], unverifiable }
// `missing` is keyed by slug so callers can map it back to candidates.
// A candidate counts as tested when its slug matches a leaderboard
// active_apps[].slug OR (fallback) its name matches active_apps[].name — the
// two platform feeds don't always agree on slug, so name is a safety net.
// `opts.demo` (staging only) injects the current user as having tested the
// full scope so the eligible branch is exercisable in a preview.
async function checkTestedAll(user, requiredCands, opts = {}) {
  // De-dupe by slug; keep the first name we see for each slug.
  const bySlug = new Map();
  for (const c of (requiredCands || [])) {
    const slug = norm(c && c.slug);
    if (!slug || bySlug.has(slug)) continue;
    bySlug.set(slug, norm(c && c.name));
  }
  const required = [...bySlug.entries()].map(([slug, name]) => ({ slug, name }));
  // Nothing enforceable (no slugged candidates) → allow. The caller surfaces
  // the "can't be enforced" note separately.
  if (required.length === 0) return { eligible: true, missing: [], unverifiable: false };

  // Staging demo pass path: treat the current user as fully tested.
  if (IS_STAGING && opts.demo) {
    return { eligible: true, missing: [], unverifiable: false };
  }

  let items;
  try {
    items = await fetchLeaderboard();
  } catch (err) {
    if (IS_STAGING) {
      items = STAGING_FALLBACK_LEADERBOARD;
    } else {
      return { eligible: false, missing: required.map((c) => c.slug), unverifiable: true };
    }
  }

  const myAddr = norm(user && user.usernode_pubkey);
  const myId = user && user.id;
  const me = items.find((it) => {
    if (myAddr && norm(it && it.address) === myAddr) return true;
    if (myId != null && it && it.user_id === myId) return true;
    return false;
  });
  // Not found → no recorded tested apps → block (disclaimer applies).
  if (!me) {
    // Diagnostic: makes a production slug/id-namespace mismatch debuggable
    // without a redeploy. Only fires on testers-only rounds (the only caller).
    console.warn(
      `[testers-gate] viewer not found in leaderboard (id=${myId}, addr=${myAddr || 'none'}, feed_size=${items.length})`
    );
    return { eligible: false, missing: required.map((c) => c.slug), unverifiable: false };
  }

  const apps = Array.isArray(me.active_apps) ? me.active_apps : [];
  const testedSlugs = new Set(apps.map((a) => norm(a && a.slug)).filter(Boolean));
  const testedNames = new Set(apps.map((a) => norm(a && a.name)).filter(Boolean));
  const missing = required
    .filter((c) => !(testedSlugs.has(c.slug) || (c.name && testedNames.has(c.name))))
    .map((c) => c.slug);
  return { eligible: missing.length === 0, missing, unverifiable: false };
}

function slugify(title) {
  const base = String(title || 'round')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'round';
  const suffix = Math.random().toString(36).slice(2, 7);
  return `${base}-${suffix}`;
}

// Who can SEE a round: creator, anyone for an `everyone` round, or an invitee.
async function canViewRound(round, user) {
  if (!user) return false;
  if (round.creator_user_id === user.id) return true;
  if (round.audience === 'everyone') return true;
  const { rows } = await pool.query(
    `SELECT 1 FROM round_invitees WHERE round_id = $1 AND lower(username) = $2 LIMIT 1`,
    [round.id, norm(user.username)]
  );
  return rows.length > 0;
}

async function getRoundBySlug(slug) {
  const { rows } = await pool.query(`SELECT * FROM rounds WHERE slug = $1`, [slug]);
  return rows[0] || null;
}

async function loadCandidates(roundId) {
  const { rows } = await pool.query(
    `SELECT id, app_name, app_url, owner_username, position, external_app_id, app_slug
       FROM round_candidates WHERE round_id = $1 ORDER BY position ASC, id ASC`,
    [roundId]
  );
  return rows;
}

// Map candidate_id -> array of { user_id, username } captured at round
// creation. Used for is_own marking and server-side self-vote enforcement.
async function loadContributorsByCandidate(roundId) {
  const { rows } = await pool.query(
    `SELECT candidate_id, user_id, username
       FROM round_candidate_contributors WHERE round_id = $1`,
    [roundId]
  );
  const byCand = new Map();
  for (const r of rows) {
    if (!byCand.has(r.candidate_id)) byCand.set(r.candidate_id, []);
    byCand.get(r.candidate_id).push({ user_id: r.user_id, username: r.username });
  }
  return byCand;
}

async function myAllocation(roundId, userId) {
  const { rows } = await pool.query(
    `SELECT candidate_id, COUNT(*)::int AS votes
       FROM votes WHERE round_id = $1 AND voter_user_id = $2
      GROUP BY candidate_id`,
    [roundId, userId]
  );
  const out = {};
  rows.forEach((r) => { out[r.candidate_id] = r.votes; });
  return out;
}

async function tallyResults(roundId) {
  const counts = await pool.query(
    `SELECT candidate_id, COUNT(*)::int AS votes
       FROM votes WHERE round_id = $1 GROUP BY candidate_id`,
    [roundId]
  );
  const voters = await pool.query(
    `SELECT COUNT(DISTINCT voter_user_id)::int AS n FROM votes WHERE round_id = $1`,
    [roundId]
  );
  const byId = {};
  counts.rows.forEach((r) => { byId[r.candidate_id] = r.votes; });
  return { byId, voterCount: voters.rows[0] ? voters.rows[0].n : 0 };
}

// Vote-distribution rule helpers. 'one_per_app' caps each app at 1 vote from a
// voter; 'concentrate' lets a voter stack all their votes on one app. The
// numeric cap (max_votes_per_app) is always derived from the rule + allowance.
const VOTE_RULES = new Set(['one_per_app', 'concentrate']);
function normalizeVoteRule(raw) {
  return VOTE_RULES.has(raw) ? raw : 'one_per_app';
}
function capForRule(rule, votesPerVoter) {
  return rule === 'concentrate' ? Math.max(1, votesPerVoter) : 1;
}

// Resolve a list of directory app ids into fully-formed candidate objects
// (name / slug / url / contributors), authoritatively from the directory —
// contributor user_ids come from the directory only, never the client, so a
// caller can't strip themselves out to unlock self-votes. Shared by the create
// handler and the admin app-edit endpoint so both stay in lockstep.
//   - skipIds: directory ids already present in the round (deduped out)
//   - skipNameKeys: lower-cased app_names already present (respects the
//     UNIQUE (round_id, app_name) constraint)
// Returns { candidates, skippedDuplicateNames } — the latter are ids that
// resolved to a name colliding with an existing/earlier one and were dropped.
function resolveDirectoryCandidates(wantIds, directory, { skipIds = new Set(), skipNameKeys = new Set() } = {}) {
  const dirById = new Map(directory.map((a) => [a.id, a]));
  const seen = new Set(skipNameKeys);
  const candidates = [];
  const skippedDuplicateNames = [];
  for (const id of wantIds) {
    if (skipIds.has(id)) continue; // already in the round
    const appRec = dirById.get(id);
    if (!appRec) continue; // dropped: not in the directory
    const name = String(appRec.name || '').trim().slice(0, 120);
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) { skippedDuplicateNames.push(name); continue; }
    seen.add(key);

    const rawContribs = Array.isArray(appRec.contributors) ? appRec.contributors : [];
    const contributors = [];
    const seenU = new Set();
    for (const c of rawContribs) {
      const uid = parseInt(c && c.user_id, 10);
      if (!Number.isFinite(uid) || seenU.has(uid)) continue;
      seenU.add(uid);
      contributors.push({ user_id: uid, username: String((c && c.username) || '').slice(0, 80) || null });
    }
    const appSlug = String(appRec.slug || '').trim().slice(0, 200) || null;
    const ownerLabel = contributors.map((c) => c.username).filter(Boolean).join(', ').slice(0, 80) || null;
    candidates.push({
      external_app_id: id,
      app_name: name,
      app_slug: appSlug,
      app_url: appUrlFromSlug(appSlug),
      owner_username: ownerLabel,
      contributors,
    });
  }
  return { candidates, skippedDuplicateNames };
}

function publicRound(round, extra = {}) {
  return {
    slug: round.slug,
    title: round.title,
    description: round.description,
    audience: round.audience,
    votes_per_voter: round.votes_per_voter,
    max_votes_per_app: round.max_votes_per_app,
    vote_rule: round.vote_rule || 'one_per_app',
    status: round.status,
    allow_self_vote: !!round.allow_self_vote,
    require_tested_all: !!round.require_tested_all,
    creator_username: round.creator_username,
    created_at: round.created_at,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

// Current user (handy for the frontend's "is this my app?" hints).
app.get('/api/me', (req, res) => {
  res.json({ id: req.user.id, username: req.user.username, is_admin: isAdmin(req.user) });
});

// PUBLIC, read-only per-round voter-participation leaderboard. Unauthenticated
// (its exact path is in PUBLIC_API_PATHS) so it must NOT touch req.user. Takes
// the round slug via ?round=<slug> — a query param, not a path segment, so the
// exact-match auth gate keeps working. Serves only public ('everyone') rounds;
// invite-only and unknown rounds both 404 so private rosters never leak.
app.get('/api/leaderboard', async (req, res) => {
  try {
    const slug = String(req.query.round || '').trim();
    if (!slug) {
      return res.status(400).json({ error: 'A round is required (e.g. ?round=<slug>).' });
    }

    const round = await getRoundBySlug(slug);
    // Same 404 for missing and invite-only so we don't reveal private rounds.
    if (!round || round.audience !== 'everyone') {
      return res.status(404).json({ error: 'Round not found.' });
    }

    let limit = parseInt(req.query.limit, 10);
    if (!Number.isFinite(limit)) limit = 100;
    if (limit < 1) limit = 1;
    if (limit > 500) limit = 500;
    let offset = parseInt(req.query.offset, 10);
    if (!Number.isFinite(offset) || offset < 0) offset = 0;

    const totals = await pool.query(
      `SELECT COUNT(DISTINCT voter_user_id)::int AS n FROM votes WHERE round_id = $1`,
      [round.id]
    );
    const count = totals.rows[0] ? totals.rows[0].n : 0;

    const { rows } = await pool.query(
      `SELECT voter_user_id AS user_id,
              MAX(voter_username) AS username,
              COUNT(*)::int AS votes_cast
         FROM votes
        WHERE round_id = $1
        GROUP BY voter_user_id
        ORDER BY votes_cast DESC, username ASC
        LIMIT $2 OFFSET $3`,
      [round.id, limit, offset]
    );

    const voters = rows.map((r) => ({
      user_id: r.user_id,
      username: r.username,
      votes_cast: r.votes_cast,
      votes_remaining: Math.max(0, round.votes_per_voter - r.votes_cast),
    }));

    res.json({
      round: {
        slug: round.slug,
        title: round.title,
        status: round.status,
        votes_per_voter: round.votes_per_voter,
        max_votes_per_app: round.max_votes_per_app,
      },
      voters,
      count,
      limit,
      offset,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Directory proxy: trimmed app list for the create-form picker. Routed
// server-side to avoid CORS and centralise the timeout/fallback. Gated by
// the existing auth middleware (no PUBLIC_API_PATHS change).
app.get('/api/apps', async (req, res) => {
  try {
    const apps = await fetchDirectoryApps();
    res.json({ apps: apps.map((a) => ({ id: a.id, name: a.name, slug: a.slug })) });
  } catch (err) {
    if (IS_STAGING) {
      return res.json({
        apps: STAGING_FALLBACK_APPS.map((a) => ({ id: a.id, name: a.name, slug: a.slug })),
        fallback: true,
      });
    }
    res.status(502).json({ error: "Couldn't reach the app directory — try again in a moment." });
  }
});

// List rounds the user may see.
app.get('/api/rounds', async (req, res) => {
  try {
    const u = req.user;
    const { rows } = await pool.query(
      `SELECT r.*,
              (SELECT COUNT(*)::int FROM round_candidates c WHERE c.round_id = r.id) AS candidate_count
         FROM rounds r
        WHERE r.audience = 'everyone'
           OR r.creator_user_id = $1
           OR EXISTS (
                SELECT 1 FROM round_invitees i
                 WHERE i.round_id = r.id AND lower(i.username) = $2
              )
        ORDER BY
          CASE r.status WHEN 'open' THEN 0 WHEN 'draft' THEN 1 ELSE 2 END,
          r.created_at DESC`,
      [u.id, norm(u.username)]
    );
    res.json({
      rounds: rows.map((r) =>
        publicRound(r, {
          candidate_count: r.candidate_count,
          mine: r.creator_user_id === u.id,
        })
      ),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create a draft round.
app.post('/api/rounds', async (req, res) => {
  const client = await pool.connect();
  try {
    const u = req.user;
    const body = req.body || {};
    const title = String(body.title || '').trim();
    const description = String(body.description || '').trim();
    const audience = body.audience === 'invite' ? 'invite' : 'everyone';
    const allowSelfVote = body.allow_self_vote === true || body.allow_self_vote === 'true';
    const requireTestedAll = body.require_tested_all === true || body.require_tested_all === 'true';
    let votesPerVoter = parseInt(body.votes_per_voter, 10);
    if (!Number.isFinite(votesPerVoter) || votesPerVoter < 1) votesPerVoter = 1;
    if (votesPerVoter > 100) votesPerVoter = 100;

    if (!title) return res.status(400).json({ error: 'A title is required.' });

    // Selected directory app ids. The client sends ONLY ids — contributors are
    // resolved authoritatively server-side below, never trusted from the
    // client (else a creator could strip themselves out to unlock self-votes).
    const rawIds = Array.isArray(body.candidate_app_ids) ? body.candidate_app_ids : [];
    const wantIds = [];
    const seenIds = new Set();
    for (const raw of rawIds) {
      const id = parseInt(raw, 10);
      if (!Number.isFinite(id) || seenIds.has(id)) continue;
      seenIds.add(id);
      wantIds.push(id);
    }
    if (wantIds.length < 2) {
      return res.status(400).json({ error: 'Pick at least 2 candidate apps.' });
    }

    // Fetch the directory server-side. Contributor user_ids come from here
    // only; we assume req.user.id shares an id space with the directory's
    // contributors[].user_id (both are the platform user id).
    let directory;
    try {
      directory = await fetchDirectoryApps();
    } catch (fetchErr) {
      if (IS_STAGING) {
        directory = STAGING_FALLBACK_APPS;
      } else {
        // No transaction started yet; the finally block releases the client.
        return res.status(502).json({ error: "Couldn't reach the app directory — try again in a moment." });
      }
    }
    // Build candidates from matched ids, preserving the creator's pick order.
    // Contributors are resolved server-side inside the helper (never trusted
    // from the client).
    const { candidates } = resolveDirectoryCandidates(wantIds, directory);
    if (candidates.length < 2) {
      return res.status(400).json({ error: 'Add at least 2 candidate apps from the directory.' });
    }

    // Vote-distribution rule (creator-chosen). The numeric per-app cap is
    // derived from it: one_per_app → 1, concentrate → the full allowance.
    const voteRule = normalizeVoteRule(body.vote_rule);
    const maxPerApp = capForRule(voteRule, votesPerVoter);

    // Invitees (only meaningful for invite audience).
    const invitees = [];
    if (audience === 'invite') {
      const list = Array.isArray(body.invitees)
        ? body.invitees
        : String(body.invitees || '').split(/[\s,]+/);
      const seenU = new Set();
      for (const raw of list) {
        const name = String(raw || '').trim();
        if (!name) continue;
        const key = name.toLowerCase();
        if (seenU.has(key)) continue;
        seenU.add(key);
        invitees.push(name.slice(0, 80));
      }
    }

    await client.query('BEGIN');
    let slug;
    // Retry slug generation on the rare unique collision.
    for (let attempt = 0; ; attempt++) {
      slug = slugify(title);
      const exists = await client.query(`SELECT 1 FROM rounds WHERE slug = $1`, [slug]);
      if (exists.rows.length === 0) break;
      if (attempt > 5) throw new Error('Could not generate a unique slug.');
    }

    const roundIns = await client.query(
      `INSERT INTO rounds
         (slug, title, description, creator_user_id, creator_username,
          audience, votes_per_voter, max_votes_per_app, status, allow_self_vote, require_tested_all, vote_rule)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'draft',$9,$10,$11)
       RETURNING *`,
      [slug, title.slice(0, 140), description.slice(0, 2000), u.id, u.username,
       audience, votesPerVoter, maxPerApp, allowSelfVote, requireTestedAll, voteRule]
    );
    const round = roundIns.rows[0];

    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      const candIns = await client.query(
        `INSERT INTO round_candidates
           (round_id, app_name, app_url, owner_username, position, external_app_id, app_slug)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (round_id, app_name) DO NOTHING
         RETURNING id`,
        [round.id, c.app_name, c.app_url, c.owner_username, i, c.external_app_id, c.app_slug]
      );
      if (!candIns.rows.length) continue; // duplicate name collapsed
      const candidateId = candIns.rows[0].id;
      for (const ct of c.contributors) {
        await client.query(
          `INSERT INTO round_candidate_contributors (round_id, candidate_id, user_id, username)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT (candidate_id, user_id) DO NOTHING`,
          [round.id, candidateId, ct.user_id, ct.username]
        );
      }
    }
    for (const name of invitees) {
      await client.query(
        `INSERT INTO round_invitees (round_id, username) VALUES ($1,$2)
         ON CONFLICT (round_id, username) DO NOTHING`,
        [round.id, name]
      );
    }
    await client.query('COMMIT');

    // Fix C: when testers-only is on, surface (don't block) candidates that
    // can't be gate-matched because they carry no slug — otherwise the round
    // silently behaves as ungated for those apps.
    let warning = null;
    if (requireTestedAll) {
      const unenforceable = candidates.filter((c) => !c.app_slug).map((c) => c.app_name);
      const enforceable = candidates.length - unenforceable.length;
      if (enforceable === 0) {
        warning =
          "Heads up: none of the selected apps could be matched to the platform's tested-apps list, so the testers-only restriction can't be enforced for this round — anyone can vote.";
      } else if (unenforceable.length) {
        warning =
          `Heads up: the testers-only restriction can't be enforced for ${unenforceable.join(', ')} (not matched to the platform's tested-apps list). The other ${enforceable} app(s) are still gated.`;
      }
    }

    res.json({ round: publicRound(round, { mine: true }), ...(warning ? { warning } : {}) });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Round detail (+ candidates, my allocation, results if allowed).
app.get('/api/rounds/:slug', async (req, res) => {
  try {
    const u = req.user;
    const round = await getRoundBySlug(req.params.slug);
    if (!round) return res.status(404).json({ error: 'Round not found.' });
    if (!(await canViewRound(round, u))) {
      return res.status(403).json({ error: 'You are not invited to this round.' });
    }

    const isCreator = round.creator_user_id === u.id;
    const candidates = await loadCandidates(round.id);
    const contribByCand = await loadContributorsByCandidate(round.id);
    const mine = await myAllocation(round.id, u.id);
    const hasVoted = Object.keys(mine).length > 0;

    // Mark each candidate the viewer contributed to — but only when the round
    // forbids self-voting. When allow_self_vote is on, nothing is "own".
    const cands = candidates.map((c) => {
      const contribs = contribByCand.get(c.id) || [];
      const isContributor = contribs.some((x) => x.user_id === u.id);
      return {
        id: c.id,
        app_name: c.app_name,
        app_url: c.app_url,
        owner_username: c.owner_username,
        // Directory-sourced (public) identity — lets the admin app-editor mark
        // which directory apps are already included and avoid re-adding them.
        external_app_id: c.external_app_id,
        app_slug: c.app_slug,
        is_own: !round.allow_self_vote && isContributor,
        my_votes: mine[c.id] || 0,
      };
    });

    const canVote = round.status === 'open';

    // Eligibility hint for require_tested_all rounds — best-effort UX so the
    // detail view can show the disclaimer + disable submit up front. The
    // authoritative gate is the vote endpoint; failing open here is harmless.
    let eligibility = null;
    if (round.require_tested_all) {
      eligibility = {
        requireTestedAll: true,
        eligible: null,
        missingNames: [],
        unverifiable: false,
        unenforceableNames: [],
      };
      // Fix A: check for EVERY viewer on an open round — including the creator,
      // who is also hard-gated at vote time. The client only blocks on
      // eligible:false / unverifiable, so eligible:null (check didn't run)
      // stays non-blocking.
      if (round.status === 'open') {
        // Enforceable candidates carry a slug; slug-less ones can't be matched.
        const requiredCands = candidates
          .filter((c) => c.app_slug)
          .map((c) => ({ slug: c.app_slug, name: c.app_name }));
        const unenforceableNames = candidates
          .filter((c) => !c.app_slug)
          .map((c) => c.app_name);
        const demo = IS_STAGING && req.query.demo === '1';
        const r = await checkTestedAll(u, requiredCands, { demo });
        const missingSet = new Set(r.missing.map(norm));
        const missingNames = candidates
          .filter((c) => c.app_slug && missingSet.has(norm(c.app_slug)))
          .map((c) => c.app_name);
        // Per-candidate tested status so the UI can show an inline notice and
        // disable that card's steppers. `cands` and `candidates` are parallel
        // arrays (cands = candidates.map). Slug-less candidates aren't in the
        // verified scope → treated as tested (not applicable), matching how
        // requiredSlugs is built. When the check couldn't run, mark slugged
        // candidates testedUnknown so the UI shows the neutral message.
        cands.forEach((c, i) => {
          const slug = candidates[i].app_slug;
          if (!slug) { c.tested = true; c.testedUnknown = false; return; }
          if (r.unverifiable) { c.tested = false; c.testedUnknown = true; return; }
          c.tested = !missingSet.has(norm(slug));
          c.testedUnknown = false;
        });
        if (unenforceableNames.length) {
          console.warn(
            `[testers-gate] round ${round.slug}: ${unenforceableNames.length} candidate(s) have no slug and can't be gate-matched`
          );
        }
        eligibility = {
          requireTestedAll: true,
          eligible: r.unverifiable ? null : r.eligible,
          missingNames,
          unverifiable: r.unverifiable,
          unenforceableNames,
        };
      }
    }

    // Results visible to: creator anytime, a voter once they've voted,
    // everyone once the round is closed — plus any admin, who manages the
    // round and needs the per-app tally to gauge the impact of removing an app.
    let results = null;
    if (isCreator || hasVoted || round.status === 'closed' || isAdmin(u)) {
      const t = await tallyResults(round.id);
      results = {
        voterCount: t.voterCount,
        candidates: cands
          .map((c) => ({ id: c.id, app_name: c.app_name, votes: t.byId[c.id] || 0 }))
          .sort((a, b) => b.votes - a.votes),
      };
    }

    // Invitee roster for the admin/creator edit form. round_invitees is
    // staging:private — only expose it to the creator or an admin, and never
    // via publicRound (which feeds list views / public payloads).
    let invitees = null;
    if (isCreator || isAdmin(u)) {
      const inv = await pool.query(
        `SELECT username FROM round_invitees WHERE round_id = $1 ORDER BY username ASC`,
        [round.id]
      );
      invitees = inv.rows.map((row) => row.username);
    }

    res.json({
      round: publicRound(round, { mine: isCreator }),
      isCreator,
      canVote,
      hasVoted,
      candidates: cands,
      results,
      eligibility,
      invitees,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Open / close transitions (creator only).
async function transition(req, res, to, from) {
  try {
    const round = await getRoundBySlug(req.params.slug);
    if (!round) return res.status(404).json({ error: 'Round not found.' });
    if (round.creator_user_id !== req.user.id) {
      return res.status(403).json({ error: 'Only the creator can do that.' });
    }
    if (from && round.status !== from) {
      return res.status(400).json({ error: `Round is ${round.status}, not ${from}.` });
    }
    const { rows } = await pool.query(
      `UPDATE rounds SET status = $1 WHERE id = $2 RETURNING *`,
      [to, round.id]
    );
    res.json({ round: publicRound(rows[0], { mine: true }) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

app.post('/api/rounds/:slug/open', (req, res) => transition(req, res, 'open', 'draft'));
app.post('/api/rounds/:slug/close', (req, res) => transition(req, res, 'closed', 'open'));

// Admin-only live toggle for the "testers only" restriction. Unlike open/close
// (creator-gated) this is gated on isAdmin so an admin can flip it on any round
// at any time. Admin check runs before the existence lookup so non-admins can't
// probe which slugs exist.
app.post('/api/rounds/:slug/require-tested', async (req, res) => {
  try {
    if (!isAdmin(req.user)) {
      return res.status(403).json({ error: 'Admins only.' });
    }
    const enabled = req.body && (req.body.enabled === true || req.body.enabled === 'true');
    const round = await getRoundBySlug(req.params.slug);
    if (!round) return res.status(404).json({ error: 'Round not found.' });
    const { rows } = await pool.query(
      `UPDATE rounds SET require_tested_all = $1 WHERE id = $2 RETURNING *`,
      [enabled, round.id]
    );
    res.json({ round: publicRound(rows[0], { mine: rows[0].creator_user_id === req.user.id }) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin-only live toggle for the vote-distribution rule. Mirrors the
// require-tested endpoint: admin-gated (403 before existence lookup so
// non-admins can't probe slugs), non-retroactive (never rewrites already-cast
// ballots), and keeps max_votes_per_app in sync with the chosen rule.
app.post('/api/rounds/:slug/vote-rule', async (req, res) => {
  try {
    if (!isAdmin(req.user)) {
      return res.status(403).json({ error: 'Admins only.' });
    }
    const rule = normalizeVoteRule(req.body && req.body.rule);
    const round = await getRoundBySlug(req.params.slug);
    if (!round) return res.status(404).json({ error: 'Round not found.' });
    const cap = capForRule(rule, round.votes_per_voter);
    const { rows } = await pool.query(
      `UPDATE rounds SET vote_rule = $1, max_votes_per_app = $2 WHERE id = $3 RETURNING *`,
      [rule, cap, round.id]
    );
    res.json({ round: publicRound(rows[0], { mine: rows[0].creator_user_id === req.user.id }) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin-only comprehensive edit of a round's core details. Same gate shape as
// the other admin mutations: 403 BEFORE the existence lookup so non-admins
// can't probe which slugs exist. Edits are non-retroactive — already-cast
// ballots are never rewritten. slug / status / creator_* / created_at are
// intentionally immutable (slug is the round's shared-link + public-leaderboard
// identity; open/close remain the creator's transitions). Reuses the create
// handler's validation/normalization for parity.
app.patch('/api/rounds/:slug', async (req, res) => {
  if (!isAdmin(req.user)) {
    return res.status(403).json({ error: 'Admins only.' });
  }
  const client = await pool.connect();
  try {
    const round = await getRoundBySlug(req.params.slug);
    if (!round) return res.status(404).json({ error: 'Round not found.' });

    const body = req.body || {};
    const title = String(body.title || '').trim();
    if (!title) return res.status(400).json({ error: 'A title is required.' });
    const description = String(body.description || '').trim();
    const audience = body.audience === 'invite' ? 'invite' : 'everyone';
    const allowSelfVote = body.allow_self_vote === true || body.allow_self_vote === 'true';
    const requireTestedAll = body.require_tested_all === true || body.require_tested_all === 'true';
    let votesPerVoter = parseInt(body.votes_per_voter, 10);
    if (!Number.isFinite(votesPerVoter) || votesPerVoter < 1) votesPerVoter = 1;
    if (votesPerVoter > 100) votesPerVoter = 100;
    // Keep the numeric per-app cap in sync with the rule + allowance, exactly
    // as create and the vote-rule endpoint do.
    const voteRule = normalizeVoteRule(body.vote_rule);
    const maxPerApp = capForRule(voteRule, votesPerVoter);

    // Invitees (only meaningful for invite audience). Parsed exactly like create.
    const invitees = [];
    if (audience === 'invite') {
      const list = Array.isArray(body.invitees)
        ? body.invitees
        : String(body.invitees || '').split(/[\s,]+/);
      const seenU = new Set();
      for (const raw of list) {
        const name = String(raw || '').trim();
        if (!name) continue;
        const key = name.toLowerCase();
        if (seenU.has(key)) continue;
        seenU.add(key);
        invitees.push(name.slice(0, 80));
      }
    }

    await client.query('BEGIN');
    const upd = await client.query(
      `UPDATE rounds
          SET title = $1, description = $2, audience = $3, votes_per_voter = $4,
              max_votes_per_app = $5, allow_self_vote = $6, require_tested_all = $7,
              vote_rule = $8
        WHERE id = $9
        RETURNING *`,
      [title.slice(0, 140), description.slice(0, 2000), audience, votesPerVoter,
       maxPerApp, allowSelfVote, requireTestedAll, voteRule, round.id]
    );
    // Replace the invitee roster wholesale. Deleting on 'everyone' keeps the
    // table tidy (canViewRound short-circuits on 'everyone' anyway).
    await client.query(`DELETE FROM round_invitees WHERE round_id = $1`, [round.id]);
    for (const name of invitees) {
      await client.query(
        `INSERT INTO round_invitees (round_id, username) VALUES ($1,$2)
         ON CONFLICT (round_id, username) DO NOTHING`,
        [round.id, name]
      );
    }
    await client.query('COMMIT');

    const updated = upd.rows[0];

    // Same testers-only "can't be enforced" heads-up as create: surface (don't
    // block) when the restriction is on but candidates carry no slug.
    let warning = null;
    if (requireTestedAll) {
      const cands = await loadCandidates(round.id);
      const unenforceable = cands.filter((c) => !c.app_slug).map((c) => c.app_name);
      const enforceable = cands.length - unenforceable.length;
      if (enforceable === 0) {
        warning =
          "Heads up: none of the selected apps could be matched to the platform's tested-apps list, so the testers-only restriction can't be enforced for this round — anyone can vote.";
      } else if (unenforceable.length) {
        warning =
          `Heads up: the testers-only restriction can't be enforced for ${unenforceable.join(', ')} (not matched to the platform's tested-apps list). The other ${enforceable} app(s) are still gated.`;
      }
    }

    res.json({
      round: publicRound(updated, { mine: updated.creator_user_id === req.user.id }),
      ...(warning ? { warning } : {}),
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Admin-only edit of a round's INCLUDED APPS — add candidates sourced from the
// platform directory and remove existing ones. Same gate shape as the other
// admin mutations: 403 BEFORE the existence lookup so non-admins can't probe
// slugs. Non-retroactive: removing a candidate cascade-deletes its votes +
// contributors (the app is gone), but every surviving app's ballots are
// untouched. Allowed at any status, for parity with PATCH / vote-rule /
// require-tested / DELETE. A round must keep at least 2 apps — enforced inside
// the transaction so a partial edit never persists.
app.put('/api/rounds/:slug/apps', async (req, res) => {
  if (!isAdmin(req.user)) {
    return res.status(403).json({ error: 'Admins only.' });
  }
  const client = await pool.connect();
  try {
    const round = await getRoundBySlug(req.params.slug);
    if (!round) return res.status(404).json({ error: 'Round not found.' });

    const body = req.body || {};

    // Parse/dedupe the requested additions (directory app ids) — same coercion
    // loop as create.
    const rawAdd = Array.isArray(body.add_app_ids) ? body.add_app_ids : [];
    const addIds = [];
    const seenAdd = new Set();
    for (const raw of rawAdd) {
      const id = parseInt(raw, 10);
      if (!Number.isFinite(id) || seenAdd.has(id)) continue;
      seenAdd.add(id);
      addIds.push(id);
    }

    // Parse/dedupe removals (existing candidate ids).
    const rawRemove = Array.isArray(body.remove_candidate_ids) ? body.remove_candidate_ids : [];
    const removeIds = new Set();
    for (const raw of rawRemove) {
      const id = parseInt(raw, 10);
      if (Number.isFinite(id)) removeIds.add(id);
    }

    const current = await loadCandidates(round.id);
    const currentById = new Map(current.map((c) => [c.id, c]));
    // Which candidates actually survive (scope removals to THIS round).
    const survivorIds = new Set(
      current.filter((c) => !removeIds.has(c.id)).map((c) => c.id)
    );
    // Directory ids + names already present AFTER removals — so we don't
    // re-offer an app that stays, but DO allow re-adding one being removed.
    const presentExternalIds = new Set();
    const presentNameKeys = new Set();
    for (const c of current) {
      if (!survivorIds.has(c.id)) continue;
      if (Number.isFinite(c.external_app_id)) presentExternalIds.add(c.external_app_id);
      if (c.app_name) presentNameKeys.add(String(c.app_name).toLowerCase());
    }

    // Resolve additions from the directory. Only fetch when there's something
    // to add — a removal-only edit never needs the directory (so it can't 502).
    let toAdd = [];
    let skippedDuplicateNames = [];
    if (addIds.length) {
      let directory;
      try {
        directory = await fetchDirectoryApps();
      } catch (fetchErr) {
        if (IS_STAGING) {
          directory = STAGING_FALLBACK_APPS;
        } else {
          return res.status(502).json({ error: "Couldn't reach the app directory — try again in a moment." });
        }
      }
      const resolved = resolveDirectoryCandidates(addIds, directory, {
        skipIds: presentExternalIds,
        skipNameKeys: presentNameKeys,
      });
      toAdd = resolved.candidates;
      skippedDuplicateNames = resolved.skippedDuplicateNames;
    }

    await client.query('BEGIN');

    // Removals first — votes + contributors cascade via ON DELETE CASCADE.
    if (removeIds.size) {
      await client.query(
        `DELETE FROM round_candidates WHERE round_id = $1 AND id = ANY($2::int[])`,
        [round.id, Array.from(removeIds)]
      );
    }

    // Additions appended after the current max position.
    const posRow = await client.query(
      `SELECT COALESCE(MAX(position), -1) AS maxpos FROM round_candidates WHERE round_id = $1`,
      [round.id]
    );
    let pos = (posRow.rows[0] ? posRow.rows[0].maxpos : -1) + 1;
    for (const c of toAdd) {
      const candIns = await client.query(
        `INSERT INTO round_candidates
           (round_id, app_name, app_url, owner_username, position, external_app_id, app_slug)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (round_id, app_name) DO NOTHING
         RETURNING id`,
        [round.id, c.app_name, c.app_url, c.owner_username, pos, c.external_app_id, c.app_slug]
      );
      if (!candIns.rows.length) { // collided with a surviving name → skipped
        skippedDuplicateNames.push(c.app_name);
        continue;
      }
      pos += 1;
      const candidateId = candIns.rows[0].id;
      for (const ct of c.contributors) {
        await client.query(
          `INSERT INTO round_candidate_contributors (round_id, candidate_id, user_id, username)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT (candidate_id, user_id) DO NOTHING`,
          [round.id, candidateId, ct.user_id, ct.username]
        );
      }
    }

    // Minimum-count guard — inside the transaction so a violating edit never
    // persists (roll the whole thing back).
    const countRow = await client.query(
      `SELECT COUNT(*)::int AS n FROM round_candidates WHERE round_id = $1`,
      [round.id]
    );
    const finalCount = countRow.rows[0] ? countRow.rows[0].n : 0;
    if (finalCount < 2) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'A round needs at least 2 apps.' });
    }

    await client.query('COMMIT');

    // Testers-only "can't be enforced" heads-up — same check as create / edit.
    const warnings = [];
    if (round.require_tested_all) {
      const cands = await loadCandidates(round.id);
      const unenforceable = cands.filter((c) => !c.app_slug).map((c) => c.app_name);
      const enforceable = cands.length - unenforceable.length;
      if (enforceable === 0) {
        warnings.push(
          "Heads up: none of the selected apps could be matched to the platform's tested-apps list, so the testers-only restriction can't be enforced for this round — anyone can vote."
        );
      } else if (unenforceable.length) {
        warnings.push(
          `Heads up: the testers-only restriction can't be enforced for ${unenforceable.join(', ')} (not matched to the platform's tested-apps list). The other ${enforceable} app(s) are still gated.`
        );
      }
    }
    if (skippedDuplicateNames.length) {
      warnings.push(
        `Skipped ${skippedDuplicateNames.join(', ')} — an app with that name is already in the round.`
      );
    }

    res.json({
      round: publicRound(round, { mine: round.creator_user_id === req.user.id }),
      candidate_count: finalCount,
      ...(warnings.length ? { warning: warnings.join(' ') } : {}),
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Permanently delete a round (admin only). The admin check runs BEFORE any
// existence lookup so non-admins can't probe which slugs exist. Child rows
// (candidates, contributors, invitees, votes) all FK into rounds with
// ON DELETE CASCADE, so a single DELETE removes everything — no orphans.
app.delete('/api/rounds/:slug', async (req, res) => {
  try {
    if (!isAdmin(req.user)) {
      return res.status(403).json({ error: 'Admins only.' });
    }
    const round = await getRoundBySlug(req.params.slug);
    if (!round) return res.status(404).json({ error: 'Round not found.' });
    await pool.query(`DELETE FROM rounds WHERE id = $1`, [round.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Cast / replace a ballot.
app.post('/api/rounds/:slug/vote', async (req, res) => {
  const client = await pool.connect();
  try {
    const u = req.user;
    const round = await getRoundBySlug(req.params.slug);
    if (!round) return res.status(404).json({ error: 'Round not found.' });
    if (round.status !== 'open') {
      return res.status(400).json({ error: 'Voting is not open for this round.' });
    }
    if (!(await canViewRound(round, u))) {
      return res.status(403).json({ error: 'You are not invited to this round.' });
    }

    // One-shot voting: once a ballot exists for this user in this round, it's
    // locked. Enforced server-side (not just via the disabled UI button) so a
    // crafted request or a double-click race can't overwrite an existing
    // ballot. The frontend surfaces this 400 via the ballot error line + toast.
    const existing = await pool.query(
      `SELECT 1 FROM votes WHERE round_id = $1 AND voter_user_id = $2 LIMIT 1`,
      [round.id, u.id]
    );
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'You already voted.' });
    }

    const candidates = await loadCandidates(round.id);

    // Testers-only gate: must have tested every app in scope. Hard enforcement
    // — blocks rather than silently allowing on any failure mode.
    if (round.require_tested_all) {
      const requiredCands = candidates
        .filter((c) => c.app_slug)
        .map((c) => ({ slug: c.app_slug, name: c.app_name }));
      const demo = IS_STAGING && req.query.demo === '1';
      const elig = await checkTestedAll(u, requiredCands, { demo });
      if (!elig.eligible) {
        if (elig.unverifiable) {
          return res.status(400).json({
            error: "We couldn't verify which apps you've tested right now — please try again in a moment.",
          });
        }
        return res.status(400).json({
          error: 'In order to vote on your favorite app, you have to test all the apps part of the voting round.',
        });
      }
    }

    const byId = new Map(candidates.map((c) => [c.id, c]));
    // Contributor membership only matters when self-voting is forbidden.
    const contribByCand = round.allow_self_vote
      ? new Map()
      : await loadContributorsByCandidate(round.id);

    // Parse allocation: [{ candidate_id, votes }]
    const raw = Array.isArray(req.body && req.body.allocation) ? req.body.allocation : [];
    const alloc = new Map();
    let total = 0;
    for (const item of raw) {
      const cid = parseInt(item && item.candidate_id, 10);
      let n = parseInt(item && item.votes, 10);
      if (!Number.isFinite(cid) || !byId.has(cid)) {
        return res.status(400).json({ error: 'Unknown candidate in ballot.' });
      }
      if (!Number.isFinite(n) || n < 0) n = 0;
      if (n === 0) continue;

      const cand = byId.get(cid);
      if (!round.allow_self_vote) {
        const contribs = contribByCand.get(cid) || [];
        if (contribs.some((x) => x.user_id === u.id)) {
          return res.status(400).json({ error: `You can't vote for your own app (${cand.app_name}).` });
        }
      }
      if (n > round.max_votes_per_app) {
        return res.status(400).json({
          error: `At most ${round.max_votes_per_app} vote(s) on "${cand.app_name}" — spread them out!`,
        });
      }
      alloc.set(cid, (alloc.get(cid) || 0) + n);
      total += n;
    }

    if (total > round.votes_per_voter) {
      return res.status(400).json({
        error: `You only have ${round.votes_per_voter} vote(s); you tried to cast ${total}.`,
      });
    }

    await client.query('BEGIN');
    await client.query(
      `DELETE FROM votes WHERE round_id = $1 AND voter_user_id = $2`,
      [round.id, u.id]
    );
    for (const [cid, n] of alloc.entries()) {
      for (let i = 0; i < n; i++) {
        await client.query(
          `INSERT INTO votes (round_id, candidate_id, voter_user_id, voter_username)
           VALUES ($1,$2,$3,$4)`,
          [round.id, cid, u.id, u.username]
        );
      }
    }
    await client.query('COMMIT');
    res.json({ ok: true, total });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Standalone results endpoint (same gating as the detail embed).
app.get('/api/rounds/:slug/results', async (req, res) => {
  try {
    const u = req.user;
    const round = await getRoundBySlug(req.params.slug);
    if (!round) return res.status(404).json({ error: 'Round not found.' });
    if (!(await canViewRound(round, u))) {
      return res.status(403).json({ error: 'You are not invited to this round.' });
    }
    const isCreator = round.creator_user_id === u.id;
    const mine = await myAllocation(round.id, u.id);
    const hasVoted = Object.keys(mine).length > 0;
    if (!(isCreator || hasVoted || round.status === 'closed')) {
      return res.status(403).json({ error: 'Vote first to see the results.' });
    }
    const candidates = await loadCandidates(round.id);
    const t = await tallyResults(round.id);
    res.json({
      voterCount: t.voterCount,
      candidates: candidates
        .map((c) => ({ id: c.id, app_name: c.app_name, votes: t.byId[c.id] || 0 }))
        .sort((a, b) => b.votes - a.votes),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

// Favicon: browsers auto-request /favicon.ico with no platform token, so
// without this it falls through to the catch-all and 401s — a console error
// that trips the no-console-errors check on every route. We don't ship an
// icon asset, so resolve it cleanly with 204 No Content. It's a GET outside
// /api/, so the auth gate already lets it through.
app.get('/favicon.ico', (_req, res) => res.status(204).end());

// HTML shell: serve the app if authenticated, otherwise an "open in Usernode"
// landing page so stray visits to the staging URL don't reveal the app.
app.get('*', (req, res) => {
  if (!req.user) {
    return res.status(401).send(`<!doctype html><meta charset=utf-8><title>Open in Usernode</title>
<body style="font-family:system-ui;background:#09090b;color:#e4e4e7;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
  <div style="max-width:24rem;padding:2rem;text-align:center">
    <h1 style="font-size:1.25rem;margin:0 0 0.5rem">Open this app inside Usernode</h1>
    <p style="color:#a1a1aa;font-size:0.9rem;margin:0 0 1.25rem">This page is served via the platform; direct visits aren't authenticated.</p>
    <a href="https://social-vibecoding.usernodelabs.org" style="display:inline-block;padding:0.5rem 1rem;background:#7c3aed;color:white;border-radius:0.5rem;text-decoration:none;font-size:0.9rem">Go to Usernode</a>
  </div>
</body>`);
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---------------------------------------------------------------------------
// Migration + staging seed
// ---------------------------------------------------------------------------

async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rounds (
      id SERIAL PRIMARY KEY,
      slug TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      creator_user_id INTEGER NOT NULL,
      creator_username VARCHAR(255) NOT NULL,
      audience TEXT NOT NULL DEFAULT 'everyone',
      votes_per_voter INTEGER NOT NULL DEFAULT 1 CHECK (votes_per_voter >= 1),
      max_votes_per_app INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'draft',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  // Per-round toggle: when false (default) contributors can't vote for their
  // own app; when true there are no self-vote restrictions.
  await pool.query(`ALTER TABLE rounds ADD COLUMN IF NOT EXISTS allow_self_vote BOOLEAN NOT NULL DEFAULT false`);
  // Per-round toggle (admin-activatable): when true, only voters who have
  // tested ("used") every app in the round may cast a ballot. Eligibility is
  // checked live against the platform leaderboard. Off by default.
  await pool.query(`ALTER TABLE rounds ADD COLUMN IF NOT EXISTS require_tested_all BOOLEAN NOT NULL DEFAULT false`);

  // Per-round vote-distribution rule (creator-set, admin-toggleable live):
  //   'one_per_app'  → a voter may place at most 1 vote on any single app
  //   'concentrate'  → a voter may pile all their votes onto one app
  // max_votes_per_app is the numeric enforcement knob and is kept in sync
  // with this label (1 for one_per_app, votes_per_voter for concentrate).
  await pool.query(`ALTER TABLE rounds ADD COLUMN IF NOT EXISTS vote_rule TEXT NOT NULL DEFAULT 'one_per_app'`);
  // Backfill the label from the stored cap for pre-existing rounds — WITHOUT
  // rewriting max_votes_per_app, so any legacy round keeps its exact current
  // behaviour until someone explicitly re-configures it. Only touches rows
  // still carrying the column default.
  await pool.query(
    `UPDATE rounds
        SET vote_rule = CASE WHEN max_votes_per_app <= 1 THEN 'one_per_app' ELSE 'concentrate' END
      WHERE vote_rule = 'one_per_app' AND max_votes_per_app > 1`
  );

  await pool.query(`
    CREATE TABLE IF NOT EXISTS round_candidates (
      id SERIAL PRIMARY KEY,
      round_id INTEGER NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
      app_name TEXT NOT NULL,
      app_url TEXT,
      owner_username TEXT,
      position INTEGER NOT NULL DEFAULT 0,
      UNIQUE (round_id, app_name)
    )
  `);
  // Which directory app each candidate was sourced from (snapshot).
  await pool.query(`ALTER TABLE round_candidates ADD COLUMN IF NOT EXISTS external_app_id INTEGER`);
  await pool.query(`ALTER TABLE round_candidates ADD COLUMN IF NOT EXISTS app_slug TEXT`);

  // Contributors captured per candidate at round creation. Sourced from the
  // PUBLIC app directory, so this is public info — table stays public and
  // only FKs into public tables (rounds / round_candidates).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS round_candidate_contributors (
      id SERIAL PRIMARY KEY,
      round_id INTEGER NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
      candidate_id INTEGER NOT NULL REFERENCES round_candidates(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL,
      username TEXT,
      UNIQUE (candidate_id, user_id)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS rcc_round_idx ON round_candidate_contributors (round_id)`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS round_invitees (
      id SERIAL PRIMARY KEY,
      round_id INTEGER NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
      username TEXT NOT NULL,
      UNIQUE (round_id, username)
    )
  `);
  // Invite lists name specific people the creator chose — owner-only content.
  await pool.query(`COMMENT ON TABLE round_invitees IS 'staging:private'`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS votes (
      id SERIAL PRIMARY KEY,
      round_id INTEGER NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
      candidate_id INTEGER NOT NULL REFERENCES round_candidates(id) ON DELETE CASCADE,
      voter_user_id INTEGER NOT NULL,
      voter_username VARCHAR(255) NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  // Per-user ballots reveal how individuals voted — only ever exposed as aggregates.
  await pool.query(`COMMENT ON TABLE votes IS 'staging:private'`);
  await pool.query(`CREATE INDEX IF NOT EXISTS votes_round_idx ON votes (round_id)`);
}

// Insert a fully-formed demo round (round + candidates + optional invitees + votes).
async function seedRound(spec) {
  const r = await pool.query(
    `INSERT INTO rounds
       (slug, title, description, creator_user_id, creator_username,
        audience, votes_per_voter, max_votes_per_app, status, allow_self_vote, require_tested_all, vote_rule)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (slug) DO NOTHING
     RETURNING id`,
    [spec.slug, spec.title, spec.description, spec.creator_user_id, spec.creator_username,
     spec.audience, spec.votes_per_voter, spec.max_votes_per_app, spec.status,
     spec.allow_self_vote === true, spec.require_tested_all === true,
     normalizeVoteRule(spec.vote_rule)]
  );
  if (r.rows.length === 0) return; // already seeded — stay idempotent
  const roundId = r.rows[0].id;

  const candIds = [];
  for (let i = 0; i < spec.candidates.length; i++) {
    const c = spec.candidates[i];
    const ci = await pool.query(
      `INSERT INTO round_candidates
         (round_id, app_name, app_url, owner_username, position, external_app_id, app_slug)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [roundId, c.app_name, c.app_url || null, c.owner_username || null, i,
       c.external_app_id || null, c.app_slug || null]
    );
    const candidateId = ci.rows[0].id;
    candIds.push(candidateId);
    for (const ct of (c.contributors || [])) {
      await pool.query(
        `INSERT INTO round_candidate_contributors (round_id, candidate_id, user_id, username)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (candidate_id, user_id) DO NOTHING`,
        [roundId, candidateId, ct.user_id, ct.username || null]
      );
    }
  }
  for (const name of (spec.invitees || [])) {
    await pool.query(
      `INSERT INTO round_invitees (round_id, username) VALUES ($1,$2)
       ON CONFLICT (round_id, username) DO NOTHING`,
      [roundId, name]
    );
  }
  // ballots: array of { voter, voter_id, picks: [candidateIndex, ...] }
  for (const b of (spec.ballots || [])) {
    for (const idx of b.picks) {
      await pool.query(
        `INSERT INTO votes (round_id, candidate_id, voter_user_id, voter_username)
         VALUES ($1,$2,$3,$4)`,
        [roundId, candIds[idx], b.voter_id, b.voter]
      );
    }
  }
}

async function seedStaging() {
  if (!IS_STAGING) return;

  // 1) Open "everyone" round, 3 votes each — CONCENTRATE rule: a voter may
  //    pile all 3 votes onto a single app.
  await seedRound({
    slug: 'staging-fav-dev-tools',
    title: 'Staging demo — Favorite Dev Tools',
    description: 'Pick your favorite tools! You have 3 votes — pile them all on one if you like. 🛠️',
    creator_user_id: 900001,
    creator_username: 'staging-demo-host',
    audience: 'everyone',
    votes_per_voter: 3,
    max_votes_per_app: 3,
    vote_rule: 'concentrate',
    status: 'open',
    candidates: [
      { app_name: 'Staging demo App Alpha', app_url: 'https://example.com/alpha', owner_username: 'staging-demo-maker-1',
        external_app_id: 990001, app_slug: 'staging-demo-alpha',
        contributors: [{ user_id: 900101, username: 'staging-demo-maker-1' }] },
      { app_name: 'Staging demo App Bravo', app_url: 'https://example.com/bravo', owner_username: 'staging-demo-maker-2',
        external_app_id: 990002, app_slug: 'staging-demo-bravo',
        contributors: [{ user_id: 900102, username: 'staging-demo-maker-2' }] },
      { app_name: 'Staging demo App Charlie', app_url: 'https://example.com/charlie', owner_username: 'staging-demo-maker-3',
        external_app_id: 990003, app_slug: 'staging-demo-charlie',
        contributors: [{ user_id: 900103, username: 'staging-demo-maker-3' }] },
      { app_name: 'Staging demo App Delta', app_url: 'https://example.com/delta', owner_username: 'staging-demo-maker-4',
        external_app_id: 990004, app_slug: 'staging-demo-delta',
        contributors: [{ user_id: 900104, username: 'staging-demo-maker-4' }] },
    ],
  });

  // 1b) Open "everyone" round, 3 votes each — ONE-PER-APP rule: each app can
  //     take at most 1 of a voter's 3 votes, so they must spread out.
  await seedRound({
    slug: 'staging-one-per-app',
    title: 'Staging demo — One Vote Per App 🎯',
    description: 'You have 3 votes, but each app can only get 1 from you — spread them out! 🎯',
    creator_user_id: 900001,
    creator_username: 'staging-demo-host',
    audience: 'everyone',
    votes_per_voter: 3,
    max_votes_per_app: 1,
    vote_rule: 'one_per_app',
    status: 'open',
    candidates: [
      { app_name: 'Staging demo App Alpha', app_url: 'https://example.com/alpha', owner_username: 'staging-demo-maker-1',
        external_app_id: 990001, app_slug: 'staging-demo-alpha',
        contributors: [{ user_id: 900101, username: 'staging-demo-maker-1' }] },
      { app_name: 'Staging demo App Bravo', app_url: 'https://example.com/bravo', owner_username: 'staging-demo-maker-2',
        external_app_id: 990002, app_slug: 'staging-demo-bravo',
        contributors: [{ user_id: 900102, username: 'staging-demo-maker-2' }] },
      { app_name: 'Staging demo App Charlie', app_url: 'https://example.com/charlie', owner_username: 'staging-demo-maker-3',
        external_app_id: 990003, app_slug: 'staging-demo-charlie',
        contributors: [{ user_id: 900103, username: 'staging-demo-maker-3' }] },
    ],
  });

  // 2) Closed round with real ballots so results render with ranked bars.
  await seedRound({
    slug: 'staging-best-game',
    title: 'Staging demo — Best Game (closed)',
    description: 'This round is closed — results are public. 🏆',
    creator_user_id: 900001,
    creator_username: 'staging-demo-host',
    audience: 'everyone',
    votes_per_voter: 2,
    max_votes_per_app: 1,
    status: 'closed',
    candidates: [
      { app_name: 'Staging demo Game One', owner_username: 'staging-demo-maker-1',
        contributors: [{ user_id: 900101, username: 'staging-demo-maker-1' }] },
      { app_name: 'Staging demo Game Two', owner_username: 'staging-demo-maker-2',
        contributors: [{ user_id: 900102, username: 'staging-demo-maker-2' }] },
      { app_name: 'Staging demo Game Three', owner_username: 'staging-demo-maker-3',
        contributors: [{ user_id: 900103, username: 'staging-demo-maker-3' }] },
    ],
    ballots: [
      { voter: 'staging-demo-voter-1', voter_id: 910001, picks: [0, 1] },
      { voter: 'staging-demo-voter-2', voter_id: 910002, picks: [0, 2] },
      { voter: 'staging-demo-voter-3', voter_id: 910003, picks: [1, 2] },
      { voter: 'staging-demo-voter-4', voter_id: 910004, picks: [0, 1] },
    ],
  });

  // 3) Invite-only draft round — exercises the (private, empty in staging)
  //    round_invitees table and the audience UI.
  await seedRound({
    slug: 'staging-secret-awards',
    title: 'Staging demo — Secret Awards (invite only)',
    description: 'Hush hush — only invited folks can see this one. 🤫',
    creator_user_id: 900001,
    creator_username: 'staging-demo-host',
    audience: 'invite',
    votes_per_voter: 1,
    max_votes_per_app: 1,
    status: 'draft',
    candidates: [
      { app_name: 'Staging demo Secret App X', owner_username: 'staging-demo-maker-1',
        contributors: [{ user_id: 900101, username: 'staging-demo-maker-1' }] },
      { app_name: 'Staging demo Secret App Y', owner_username: 'staging-demo-maker-2',
        contributors: [{ user_id: 900102, username: 'staging-demo-maker-2' }] },
    ],
    invitees: ['staging-demo-guest-1', 'staging-demo-guest-2'],
  });

  // 4) Self-vote OFF (default) — the host (900001) is a contributor on the
  //    first app, so opening this round AS the host shows that card blocked.
  await seedRound({
    slug: 'staging-selfvote-off',
    title: 'Staging demo — Self-Vote Showcase (no self-voting)',
    description: 'Self-voting is OFF here: contributors can\'t vote for their own app. 🚫',
    creator_user_id: 900001,
    creator_username: 'staging-demo-host',
    audience: 'everyone',
    votes_per_voter: 2,
    max_votes_per_app: 1,
    status: 'open',
    allow_self_vote: false,
    candidates: [
      { app_name: 'Staging demo Host\'s Own App', app_url: appUrlFromSlug('staging-demo-host-app'),
        external_app_id: 990010, app_slug: 'staging-demo-host-app', owner_username: 'staging-demo-host',
        contributors: [{ user_id: 900001, username: 'staging-demo-host' }] },
      { app_name: 'Staging demo Rival App', app_url: appUrlFromSlug('staging-demo-rival'),
        external_app_id: 990011, app_slug: 'staging-demo-rival', owner_username: 'staging-demo-maker-2',
        contributors: [{ user_id: 900102, username: 'staging-demo-maker-2' }] },
    ],
  });

  // 5) Self-vote ON — same shape, but everyone (including contributors) can
  //    vote for any app.
  await seedRound({
    slug: 'staging-selfvote-on',
    title: 'Staging demo — Self-Vote Showcase (self-voting allowed)',
    description: 'Self-voting is ON here: anyone can vote for any app, even their own. 🙋',
    creator_user_id: 900001,
    creator_username: 'staging-demo-host',
    audience: 'everyone',
    votes_per_voter: 2,
    max_votes_per_app: 1,
    status: 'open',
    allow_self_vote: true,
    candidates: [
      { app_name: 'Staging demo Open App One', app_url: appUrlFromSlug('staging-demo-open-1'),
        external_app_id: 990012, app_slug: 'staging-demo-open-1', owner_username: 'staging-demo-host',
        contributors: [{ user_id: 900001, username: 'staging-demo-host' }] },
      { app_name: 'Staging demo Open App Two', app_url: appUrlFromSlug('staging-demo-open-2'),
        external_app_id: 990013, app_slug: 'staging-demo-open-2', owner_username: 'staging-demo-maker-3',
        contributors: [{ user_id: 900103, username: 'staging-demo-maker-3' }] },
    ],
  });

  // 6) Disposable round for exercising the admin delete affordance. Closed
  //    with real ballots so the cascade visibly removes candidates AND votes.
  //    Idempotent reseed on boot, so deleting it in staging is safe.
  await seedRound({
    slug: 'staging-deletable-demo',
    title: 'Staging demo — Safe to Delete 🗑️',
    description: 'Admins only: hit Delete round to remove this one. It reappears on the next staging boot. 🧹',
    creator_user_id: 900001,
    creator_username: 'staging-demo-host',
    audience: 'everyone',
    votes_per_voter: 2,
    max_votes_per_app: 1,
    status: 'closed',
    candidates: [
      { app_name: 'Staging demo Doomed App One', owner_username: 'staging-demo-maker-1',
        contributors: [{ user_id: 900101, username: 'staging-demo-maker-1' }] },
      { app_name: 'Staging demo Doomed App Two', owner_username: 'staging-demo-maker-2',
        contributors: [{ user_id: 900102, username: 'staging-demo-maker-2' }] },
      { app_name: 'Staging demo Doomed App Three', owner_username: 'staging-demo-maker-3',
        contributors: [{ user_id: 900103, username: 'staging-demo-maker-3' }] },
    ],
    ballots: [
      { voter: 'staging-demo-voter-1', voter_id: 910001, picks: [0, 1] },
      { voter: 'staging-demo-voter-2', voter_id: 910002, picks: [0, 2] },
      { voter: 'staging-demo-voter-3', voter_id: 910003, picks: [1, 2] },
    ],
  });

  // 7) Open "everyone" round that exercises the public voter-participation
  //    endpoint (/api/leaderboard?round=staging-voting-progress). 3 votes each,
  //    with ballots deliberately leaving a spread of unspent votes so the
  //    votes_remaining math is visible: voter-1 cast 1 (remaining 2),
  //    voter-2 cast 2 (remaining 1), voter-3 cast 3 (remaining 0).
  await seedRound({
    slug: 'staging-voting-progress',
    title: 'Staging demo — Voting In Progress 🗳️',
    description: 'Open round with partial ballots — watch unspent votes via the public leaderboard API. 📊',
    creator_user_id: 900001,
    creator_username: 'staging-demo-host',
    audience: 'everyone',
    votes_per_voter: 3,
    max_votes_per_app: 2,
    status: 'open',
    candidates: [
      { app_name: 'Staging demo Progress App One', owner_username: 'staging-demo-maker-1',
        contributors: [{ user_id: 900101, username: 'staging-demo-maker-1' }] },
      { app_name: 'Staging demo Progress App Two', owner_username: 'staging-demo-maker-2',
        contributors: [{ user_id: 900102, username: 'staging-demo-maker-2' }] },
      { app_name: 'Staging demo Progress App Three', owner_username: 'staging-demo-maker-3',
        contributors: [{ user_id: 900103, username: 'staging-demo-maker-3' }] },
    ],
    ballots: [
      { voter: 'staging-demo-voter-1', voter_id: 910001, picks: [0] },          // 1 cast → 2 remaining
      { voter: 'staging-demo-voter-2', voter_id: 910002, picks: [0, 1] },       // 2 cast → 1 remaining
      { voter: 'staging-demo-voter-3', voter_id: 910003, picks: [0, 1, 2] },    // 3 cast → 0 remaining
    ],
  });

  // 8) Open "everyone" round with the testers-only restriction ON. The seeded
  //    tester is not in STAGING_FALLBACK_LEADERBOARD, so by default they're
  //    blocked and the disclaimer renders. Append ?demo=1 to the round URL to
  //    exercise the eligible (submit-enabled) path. Candidate slugs reuse the
  //    existing fake directory slugs so eligibility matching is meaningful.
  await seedRound({
    slug: 'staging-tested-gate',
    title: 'Staging demo — Testers Only Gate 🧪',
    description: 'Restricted: you must have tested every app to vote. Blocked by default; add ?demo=1 to the URL to qualify. 🔬',
    creator_user_id: 900001,
    creator_username: 'staging-demo-host',
    audience: 'everyone',
    votes_per_voter: 2,
    max_votes_per_app: 1,
    status: 'open',
    require_tested_all: true,
    candidates: [
      { app_name: 'Staging demo App Alpha', app_url: appUrlFromSlug('staging-demo-alpha'),
        external_app_id: 990001, app_slug: 'staging-demo-alpha', owner_username: 'staging-demo-maker-1',
        contributors: [{ user_id: 900101, username: 'staging-demo-maker-1' }] },
      { app_name: 'Staging demo App Bravo', app_url: appUrlFromSlug('staging-demo-bravo'),
        external_app_id: 990002, app_slug: 'staging-demo-bravo', owner_username: 'staging-demo-maker-2',
        contributors: [{ user_id: 900102, username: 'staging-demo-maker-2' }] },
      { app_name: 'Staging demo App Charlie', app_url: appUrlFromSlug('staging-demo-charlie'),
        external_app_id: 990003, app_slug: 'staging-demo-charlie', owner_username: 'staging-demo-maker-3',
        contributors: [{ user_id: 900103, username: 'staging-demo-maker-3' }] },
    ],
  });

  // 9) Testers-only round exercising the NAME-FALLBACK match (fix B). The two
  //    candidates carry slugs that DON'T appear in STAGING_FALLBACK_LEADERBOARD
  //    (so a slug-only match would miss), but their names ('Staging demo App
  //    Alpha' / 'Staging demo App Bravo') DO appear there — so a viewer in the
  //    leaderboard qualifies via name. The seeded tester isn't in the fallback,
  //    so by default they're still blocked; add ?demo=1 to the URL to render the
  //    eligible, submit-enabled ballot (steppers appear on every card).
  await seedRound({
    slug: 'staging-name-fallback',
    title: 'Staging demo — Name Fallback Gate 🔤',
    description: 'Testers-only round whose apps match the tested-apps list by NAME, not slug. Blocked by default; add ?demo=1 to qualify. 🧷',
    creator_user_id: 900001,
    creator_username: 'staging-demo-host',
    audience: 'everyone',
    votes_per_voter: 2,
    max_votes_per_app: 1,
    status: 'open',
    require_tested_all: true,
    candidates: [
      // Slug intentionally mismatched vs the leaderboard's 'staging-demo-alpha'.
      { app_name: 'Staging demo App Alpha', app_url: appUrlFromSlug('staging-demo-alpha'),
        external_app_id: 990001, app_slug: 'staging-demo-alpha-renamed', owner_username: 'staging-demo-maker-1',
        contributors: [{ user_id: 900101, username: 'staging-demo-maker-1' }] },
      { app_name: 'Staging demo App Bravo', app_url: appUrlFromSlug('staging-demo-bravo'),
        external_app_id: 990002, app_slug: 'staging-demo-bravo-renamed', owner_username: 'staging-demo-maker-2',
        contributors: [{ user_id: 900102, username: 'staging-demo-maker-2' }] },
    ],
  });

  // 10) Testers-only round where one candidate has NO slug and so can't be
  //     gate-matched (fix C). The round-level "can't be enforced for …" note
  //     renders for every viewer; the slugged candidate is still gated.
  await seedRound({
    slug: 'staging-unenforceable-gate',
    title: 'Staging demo — Unenforceable Gate ⚠️',
    description: 'Testers-only, but one app has no directory slug so the rule can\'t be enforced for it. 🫥',
    creator_user_id: 900001,
    creator_username: 'staging-demo-host',
    audience: 'everyone',
    votes_per_voter: 2,
    max_votes_per_app: 1,
    status: 'open',
    require_tested_all: true,
    candidates: [
      { app_name: 'Staging demo App Alpha', app_url: appUrlFromSlug('staging-demo-alpha'),
        external_app_id: 990001, app_slug: 'staging-demo-alpha', owner_username: 'staging-demo-maker-1',
        contributors: [{ user_id: 900101, username: 'staging-demo-maker-1' }] },
      // No app_slug → unmatchable → surfaced in eligibility.unenforceableNames.
      { app_name: 'Staging demo Slugless App', owner_username: 'staging-demo-maker-4',
        contributors: [{ user_id: 900104, username: 'staging-demo-maker-4' }] },
    ],
  });

  // 11) Open round for exercising the admin "Edit included apps" flow. Seeded
  //     with THREE of the four fallback directory apps (Alpha/Bravo/Charlie),
  //     so Delta (990004) is available to ADD, and at 3 apps one can be REMOVED
  //     while staying ≥ 2. Alpha carries a couple of votes so a tester sees the
  //     "removing this app deletes its N votes" warning and can confirm the
  //     cascade. Staging users are all admins, so any tester can open the panel.
  await seedRound({
    slug: 'staging-edit-apps',
    title: 'Staging demo — Edit apps 🧩',
    description: 'Admin can add/remove the competing apps here. Delta is available to add; Alpha already has votes so removing it warns about discarding them. 🧩',
    creator_user_id: 900001,
    creator_username: 'staging-demo-host',
    audience: 'everyone',
    votes_per_voter: 1,
    max_votes_per_app: 1,
    vote_rule: 'one_per_app',
    status: 'open',
    candidates: [
      { app_name: 'Staging demo App Alpha', app_url: appUrlFromSlug('staging-demo-alpha'), owner_username: 'staging-demo-maker-1',
        external_app_id: 990001, app_slug: 'staging-demo-alpha',
        contributors: [{ user_id: 900101, username: 'staging-demo-maker-1' }] },
      { app_name: 'Staging demo App Bravo', app_url: appUrlFromSlug('staging-demo-bravo'), owner_username: 'staging-demo-maker-2',
        external_app_id: 990002, app_slug: 'staging-demo-bravo',
        contributors: [{ user_id: 900102, username: 'staging-demo-maker-2' }] },
      { app_name: 'Staging demo App Charlie', app_url: appUrlFromSlug('staging-demo-charlie'), owner_username: 'staging-demo-maker-3',
        external_app_id: 990003, app_slug: 'staging-demo-charlie',
        contributors: [{ user_id: 900103, username: 'staging-demo-maker-3' }] },
    ],
    ballots: [
      { voter: 'staging-demo-voter-1', voter_id: 910001, picks: [0] }, // Alpha
      { voter: 'staging-demo-voter-2', voter_id: 910002, picks: [0] }, // Alpha → 2 votes
    ],
  });
}

async function start() {
  await migrate();
  await seedStaging();
  app.listen(port, () => console.log(`Listening on :${port}`));
}

start().catch(err => { console.error(err); process.exit(1); });
