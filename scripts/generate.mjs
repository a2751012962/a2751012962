#!/usr/bin/env node
// Draws every SVG in assets/ from live GitHub data, once per GitHub theme.
// Zero dependencies. Needs Node 20+ and a token in GH_TOKEN or GITHUB_TOKEN.
//   GH_TOKEN=$(gh auth token) node scripts/generate.mjs
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'assets');
const LOGIN = process.env.PROFILE_LOGIN || process.env.GITHUB_REPOSITORY_OWNER || 'a2751012962';
const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;

// ───────────────────────────── content ─────────────────────────────
// What to show is set in profile.json, next to the README. Edit it and push:
//   name, tagline        the headline and the two lines under it
//   includePrivate       true counts private repos everywhere: contributions, repo total, languages.
//                        That needs a token that can read them: locally `gh auth token`,
//                        in the Action a PROFILE_TOKEN secret. Without one the Action leaves
//                        the drawings as they are instead of redrawing them from public data.
//   link                 { "label": "LinkedIn", "url": "https://..." } the button under the tagline;
//                        the whole headline links there
//   projects.minCommits  a repo needs at least this many commits of mine to get a card
//   projects.max         most cards to show
//   projects.hide        ["owner/repo", ...] never shown
//   projects.pin         ["owner/repo", ...] shown even below minCommits
//   projects.details     per repo: "title" and "blurb" (otherwise the repo name and description).
//                        A private repo needs "private": true plus "commits" and "language" here,
//                        because neither the Action nor a visitor can read it; its card has no link.
// The cards are every public repo I have commits in, most commits first.
const CONFIG = JSON.parse(await readFile(join(ROOT, 'profile.json'), 'utf8'));
const NAME = CONFIG.name;
const TAGLINE = CONFIG.tagline;
const LINK = CONFIG.link?.label && /^https:\/\//.test(CONFIG.link.url ?? '') ? CONFIG.link : null;
const PRIVATE = CONFIG.includePrivate === true;
const SCOPE = PRIVATE ? '' : 'privacy:PUBLIC, ';
const SHOW = { minCommits: 1, max: 6, hide: [], pin: [], details: {}, ...CONFIG.projects };

// ───────────────────────────── look ─────────────────────────────
// System type (San Francisco on Apple devices), tight bold headlines, neutral greys,
// soft filled cards with generous corners and a single blue accent.
// Text is at least 4.5:1 on both the page and the card fill; the accent at least 3:1.
const THEMES = {
  light: { ink: '#1d1d1f', mute: '#63636a', card: '#f5f5f7', rule: '#d2d2d7', accent: '#0066cc', chip: 'rgba(0,0,0,.07)',
    ramp: ['#e5e5ea', '#b9d7f7', '#7fb6f0', '#3d8fe6', '#0066cc'], tileEdge: '#d6d6dc', front: 0.86, side: 0.7,
  },
  dark: { ink: '#f5f5f7', mute: '#a1a1a6', card: '#161b22', rule: '#30363d', accent: '#2997ff', chip: 'rgba(255,255,255,.1)',
    ramp: ['#1f252e', '#143a66', '#1b5fa8', '#2484e6', '#5cb0ff'], tileEdge: '#2b323c', front: 0.78, side: 0.58,
  },
};
const SANS = "-apple-system,BlinkMacSystemFont,'SF Pro Display','SF Pro Text','Helvetica Neue','Segoe UI',Arial,sans-serif";
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// Nothing in these drawings animates, on purpose. On GitHub's pages Chrome often stops repainting
// an animated SVG image about a second after load (measured: 3 of 6 loads of a README page, 5 of 5
// of the profile page, against 0 of 6 for the same file on a plain page). The image then only
// updates when something else repaints it, so an entrance animation plays at a few frames a
// second or leaves the content half faded. A still image is always complete.

const f = (n) => +n.toFixed(1);
const shade = (hex, k) =>
  '#' + [1, 3, 5].map((i) => Math.min(255, Math.round(parseInt(hex.slice(i, i + 2), 16) * k)).toString(16).padStart(2, '0')).join('');
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const wrap = (s, n) => {
  const out = [];
  let line = '';
  for (const w of s.split(' ')) {
    const next = line ? `${line} ${w}` : w;
    if (next.length > n && line) { out.push(line); line = w; } else line = next;
  }
  if (line) out.push(line);
  return out;
};

const svg = (w, h, t, body, { css = '', label = '', card = true } = {}) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${esc(label)}">
<title>${esc(label)}</title>
<style>text{font-family:${SANS};fill:${t.ink}}.mute{fill:${t.mute}}.accent{fill:${t.accent}}.eyebrow{font-size:13px;font-weight:600;fill:${t.mute}}.big{font-weight:700;letter-spacing:-.022em}.num{font-variant-numeric:tabular-nums}${css}</style>
${card ? `<rect width="${w}" height="${h}" rx="20" fill="${t.card}"/>` : ''}${body}
</svg>
`;

// ───────────────────────────── data ─────────────────────────────
async function gql(query, variables = {}) {
  if (!TOKEN) throw new Error('Set GH_TOKEN or GITHUB_TOKEN (e.g. GH_TOKEN=$(gh auth token)).');
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { authorization: `bearer ${TOKEN}`, 'content-type': 'application/json', 'user-agent': 'profile-cards' },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (!res.ok || json.errors) throw new Error(`GitHub GraphQL failed: ${res.status} ${JSON.stringify(json.errors ?? json)}`);
  return json.data;
}

async function load() {
  const data = await gql(
    `query($login:String!){
      viewer{ login }
      user(login:$login){
        id
        createdAt
        pub: repositories(${SCOPE}ownerAffiliations:OWNER){ totalCount }
        own: repositories(first:100, ${SCOPE}ownerAffiliations:OWNER, isFork:false){
          nodes{ languages(first:15, orderBy:{field:SIZE, direction:DESC}){ edges{ size node{ name color } } } }
        }
        contributionsCollection{ restrictedContributionsCount commitContributionsByRepository(maxRepositories:100){ repository{ isPrivate } } contributionCalendar{ weeks{ contributionDays{ date contributionCount contributionLevel } } } }
      }
    }`,
    { login: LOGIN },
  );
  if (!data.user) throw new Error(`No such user: ${LOGIN}`);
  if (PRIVATE && data.viewer.login.toLowerCase() !== LOGIN.toLowerCase()) {
    console.log(`includePrivate is on, but this token belongs to ${data.viewer.login} and cannot read ${LOGIN}'s private repos. Add a PROFILE_TOKEN secret; nothing was redrawn.`);
    return null;
  }

  // Every public repo I have commits in: my own (forks excluded) and others I contributed to.
  const FIELDS = `nameWithOwner name description stargazerCount owner{ login } primaryLanguage{ name color } defaultBranchRef{ target{ ... on Commit{ history(author:{id:$id}){ totalCount } } } }`;
  const mine = await gql(
    `query($login:String!, $id:ID!){
      user(login:$login){
        own: repositories(first:100, privacy:PUBLIC, ownerAffiliations:OWNER, isFork:false){ nodes{ ${FIELDS} } }
        others: repositoriesContributedTo(first:100, privacy:PUBLIC, includeUserRepositories:false, contributionTypes:[COMMIT, PULL_REQUEST]){ nodes{ ${FIELDS} } }
      }
      ${SHOW.pin.map((repo, i) => {
        const [owner, name] = repo.split('/');
        return `pin${i}: repository(owner:"${owner}", name:"${name}"){ ${FIELDS} }`;
      }).join(' ')}
    }`,
    { login: LOGIN, id: data.user.id },
  );
  const same = (a, b) => a.toLowerCase() === b.toLowerCase();
  const listed = (list, repo) => list.some((x) => same(x, repo));
  const found = new Map();
  for (const r of [...mine.user.own.nodes, ...mine.user.others.nodes, ...SHOW.pin.map((_, i) => mine[`pin${i}`])])
    if (r) found.set(r.nameWithOwner.toLowerCase(), r);
  const manual = Object.entries(SHOW.details)
    .filter(([, x]) => x.private)
    .map(([repo, x]) => ({
      repo, private: true, title: x.title ?? repo.split('/')[1], blurb: x.blurb ?? '', role: 'Private', stars: 0,
      lang: x.language ? { name: x.language, color: x.languageColor ?? null } : null,
      commits: x.commits ?? 0,
    }));
  const projects = [...found.values()]
    .filter((r) => !manual.some((m) => same(m.repo, r.nameWithOwner)))
    .map((r) => {
      const extra = Object.entries(SHOW.details).find(([k]) => same(k, r.nameWithOwner))?.[1] ?? {};
      return {
        repo: r.nameWithOwner,
        title: extra.title ?? r.name,
        blurb: extra.blurb ?? r.description ?? '',
        role: same(r.owner.login, LOGIN) ? null : 'Contributor',
        stars: r.stargazerCount,
        lang: r.primaryLanguage,
        commits: r.defaultBranchRef?.target?.history?.totalCount ?? 0,
      };
    })
    .concat(manual)
    .filter((p) => !listed(SHOW.hide, p.repo) && (listed(SHOW.pin, p.repo) || p.commits >= SHOW.minCommits))
    .sort((a, b) => b.commits - a.commits)
    .slice(0, SHOW.max);

  const LEVEL = { NONE: 0, FIRST_QUARTILE: 1, SECOND_QUARTILE: 2, THIRD_QUARTILE: 3, FOURTH_QUARTILE: 4 };
  const weeks = data.user.contributionsCollection.contributionCalendar.weeks.map((w) =>
    w.contributionDays.map((d) => ({
      date: d.date, count: d.contributionCount, level: LEVEL[d.contributionLevel] ?? 0,
      dow: new Date(`${d.date}T00:00:00Z`).getUTCDay(),
    })),
  );
  const days = weeks.flat();

  // Whether GitHub's calendar already holds my private work depends on the token: one with the
  // read:user scope (or an account that shares private contributions) gets the full calendar, and
  // then nothing is added. Otherwise the calendar is public only, and with includePrivate the
  // private part is rebuilt here from what GitHub counts as a contribution: my commits on each
  // private repo's default branch, the pull requests and issues I opened there, and the private
  // repos I created, each on its own day.
  const cc = data.user.contributionsCollection;
  const shared = cc.restrictedContributionsCount > 0 || cc.commitContributionsByRepository.some((c) => c.repository.isPrivate);
  let added = 0, newDays = 0;
  if (PRIVATE && !shared) {
    const since = `${days[0].date}T00:00:00Z`;
    const byDate = new Map(days.map((d) => [d.date, d]));
    const before = new Set(days.filter((d) => d.count).map((d) => d.date));
    const HIST = `history(author:{id:$id}, since:$since, first:100, after:$after){ nodes{ authoredDate } pageInfo{ hasNextPage endCursor } }`;
    const VARS = `query($id:ID!, $since:GitTimestamp!, $after:String)`;
    const priv = await gql(
      `${VARS}{ viewer{ repositories(first:100, privacy:PRIVATE, ownerAffiliations:[OWNER, COLLABORATOR, ORGANIZATION_MEMBER]){ nodes{ nameWithOwner createdAt owner{ login } defaultBranchRef{ target{ ... on Commit{ ${HIST} } } } } } } }`,
      { id: data.user.id, since, after: null },
    );
    const bump = (iso) => {
      const day = byDate.get(iso.slice(0, 10));
      if (day) { day.count++; added++; }
    };
    for (const repo of priv.viewer.repositories.nodes) {
      if (repo.owner.login.toLowerCase() === LOGIN.toLowerCase()) bump(repo.createdAt);
      let page = repo.defaultBranchRef?.target?.history;
      while (page) {
        for (const c of page.nodes) bump(c.authoredDate);
        if (!page.pageInfo.hasNextPage) break;
        const [owner, name] = repo.nameWithOwner.split('/');
        const more = await gql(
          `${VARS}{ repository(owner:"${owner}", name:"${name}"){ defaultBranchRef{ target{ ... on Commit{ ${HIST} } } } } }`,
          { id: data.user.id, since, after: page.pageInfo.endCursor },
        );
        page = more.repository.defaultBranchRef.target.history;
      }
    }
    for (let after = null; ;) {
      const found = await gql(
        `query($q:String!, $after:String){ search(query:$q, type:ISSUE, first:100, after:$after){ nodes{ ... on PullRequest{ createdAt } ... on Issue{ createdAt } } pageInfo{ hasNextPage endCursor } } }`,
        { q: `author:${LOGIN} is:private created:>=${days[0].date}`, after },
      );
      for (const item of found.search.nodes) if (item.createdAt) bump(item.createdAt);
      if (!found.search.pageInfo.hasNextPage) break;
      after = found.search.pageInfo.endCursor;
    }
    newDays = days.filter((d) => d.count && !before.has(d.date)).length;
    // Shade by quartile of the active days, as GitHub does.
    const ranked = days.filter((d) => d.count).map((d) => d.count).sort((a, b) => a - b);
    const cut = (q) => ranked[Math.min(ranked.length - 1, Math.floor(ranked.length * q))] ?? 0;
    const [q1, q2, q3] = [cut(0.25), cut(0.5), cut(0.75)];
    for (const d of days) d.level = !d.count ? 0 : d.count <= q1 ? 1 : d.count <= q2 ? 2 : d.count <= q3 ? 3 : 4;
  }

  let longest = 0, run = 0;
  for (const d of days) { run = d.count ? run + 1 : 0; longest = Math.max(longest, run); }

  // Each repo contributes its own language mix with equal weight.
  const share = new Map();
  let counted = 0;
  for (const repo of data.user.own.nodes) {
    const size = repo.languages.edges.reduce((n, e) => n + e.size, 0);
    if (!size) continue;
    counted++;
    for (const e of repo.languages.edges) {
      const cur = share.get(e.node.name) ?? { name: e.node.name, color: e.node.color ?? '#8e8e93', size: 0 };
      cur.size += e.size / size;
      share.set(e.node.name, cur);
    }
  }
  const sorted = [...share.values()].sort((a, b) => b.size - a.size);
  const totalBytes = counted || 1;
  const top = sorted.slice(0, 7);
  const rest = sorted.slice(7).reduce((n, l) => n + l.size, 0);
  if (rest > 0.0005) top.push({ name: 'Other', color: '#8e8e93', size: rest });

  return {
    weeks, days, longest, added, newDays, shared,
    total: days.reduce((s, d) => s + d.count, 0),
    active: days.filter((d) => d.count).length,
    best: days.reduce((a, b) => (b.count > a.count ? b : a), days[0]),
    langs: top.map((l) => ({ ...l, pct: (l.size / totalBytes) * 100 })),
    publicRepos: data.user.pub.totalCount,
    since: data.user.createdAt.slice(0, 4),
    projects,
  };
}

// ───────────────────────────── masthead ─────────────────────────────
// One image that scales as a whole: name, tagline and button on the left, the contributions
// card on the right, in the same arrangement at every width.
function masthead(t, d) {
  const W = 1200, H = 300, CX = 640, X0 = 676, X1 = 1164, YB = 244, YT = 156;
  const n = d.days.length;
  let cum = 0;
  const pts = d.days.map((x, i) => {
    cum += x.count;
    return [f(X0 + (i / (n - 1)) * (X1 - X0)), f(YB - (cum / Math.max(1, d.total)) * (YB - YT))];
  });
  const kept = pts.filter((p, i) => i === 0 || i === n - 1 || p[1] !== pts[i - 1][1] || p[1] !== pts[i + 1][1]);
  const line = 'M' + kept.map((p) => p.join(' ')).join('L');
  const [ex, ey] = pts[n - 1];

  let months = '', last = -99;
  d.days.forEach((x, i) => {
    if (!x.date.endsWith('-01')) return;
    const tx = pts[i][0];
    if (tx - last < 74 || tx > X1 - 30) return;
    months += `<text class="mute" x="${tx}" y="${YB + 28}" font-size="15">${MONTHS[+x.date.slice(5, 7) - 1]}</text>`;
    last = tx;
  });

  const bw = LINK ? Math.round(LINK.label.length * 11.2 + 64) : 0;
  const button = LINK
    ? `<g><rect x="3" y="236" width="${bw}" height="42" rx="21" fill="#0071e3"/><text x="25" y="263.5" font-size="19" font-weight="600" style="fill:#fff">${esc(LINK.label)}</text><path d="M${bw - 30} 262l9 -9m-6.5 0h6.5v6.5" fill="none" stroke="#fff" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></g>`
    : '';

  const body = `
<defs><linearGradient id="fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${t.accent}" stop-opacity=".32"/><stop offset="1" stop-color="${t.accent}" stop-opacity="0"/></linearGradient></defs>
<text class="big" x="0" y="${LINK ? 112 : 128}" font-size="118" style="letter-spacing:-.035em">${esc(NAME)}</text>
${TAGLINE.map((p, k) => `<text class="mute" x="3" y="${(LINK ? 170 : 190) + k * 37}" font-size="29" font-weight="600" style="letter-spacing:-.015em">${esc(p)}</text>`).join('\n')}
${button}
<rect x="${CX}" width="${W - CX}" height="${H}" rx="28" fill="${t.card}"/>
<text class="mute" x="${X0}" y="48" font-size="17" font-weight="600">Contributions</text>
<text class="big num" x="${X0 - 2}" y="112" font-size="64">${d.total.toLocaleString('en-US')}</text>
<text class="mute" x="${X0}" y="138" font-size="17">in the last 12 months</text>
<path d="${line}L${X1} ${YB}L${X0} ${YB}Z" fill="url(#fill)"/>
<path d="${line}" fill="none" stroke="${t.accent}" stroke-width="3.5" stroke-linejoin="round" stroke-linecap="round"/>
<circle cx="${ex}" cy="${ey}" r="6" fill="${t.accent}"/>
${months}`;
  return svg(W, H, t, body, { card: false, label: `${NAME}. ${TAGLINE.join(' ')} ${d.total} contributions in the last 12 months.` });
}

// ───────────────────────────── figures ─────────────────────────────
function figures(t, d) {
  const W = 460, H = 214;
  const [, m, day] = d.best.date.split('-').map(Number);
  const figs = [
    [d.active, 'active days'],
    [(d.total / Math.max(1, d.active)).toFixed(1), 'per active day'],
    [d.best.count, `busiest day, ${MONTHS[m - 1]} ${day}`],
    [d.longest, 'day longest streak'],
    [d.publicRepos, PRIVATE ? 'repositories' : 'public repos'],
    [d.since, 'joined GitHub'],
  ];
  const body = `
<text class="eyebrow" x="24" y="38">Activity, last 12 months</text>
${figs.map(([v, k], i) => {
    const x = 24 + (i % 3) * 144, y = 98 + Math.floor(i / 3) * 72;
    return `<g><text class="big num" x="${x}" y="${y}" font-size="34">${esc(v)}</text><text class="mute" x="${x}" y="${y + 21}" font-size="12.5">${esc(k)}</text></g>`;
  }).join('\n')}`;
  return svg(W, H, t, body, {
    label: `Last 12 months: ${figs.map(([v, k]) => `${v} ${k}`).join(', ')}`,
  });
}

// ───────────────────────────── languages ─────────────────────────────
function languages(t, d) {
  const W = 460, H = 214, BX = 24, BW = W - 48;
  let x = BX, bar = '';
  for (const l of d.langs) {
    const w = (l.pct / 100) * BW;
    if (w > 2) bar += `<rect x="${f(x)}" y="56" width="${f(w - 2)}" height="10" fill="${l.color}"/>`;
    x += w;
  }
  const legend = d.langs.map((l, i) => {
    const lx = 24 + (i % 2) * 212, ly = 102 + Math.floor(i / 2) * 28;
    return `<g><circle cx="${lx + 5}" cy="${ly - 4.5}" r="4.5" fill="${l.color}"/><text x="${lx + 18}" y="${ly}" font-size="13.5">${esc(l.name)}</text><text class="mute num" x="${lx + 196}" y="${ly}" font-size="13" text-anchor="end">${l.pct.toFixed(1)}%</text></g>`;
  }).join('\n');
  const body = `
<defs><clipPath id="bar"><rect x="${BX}" y="56" height="10" rx="5" width="${BW}"/></clipPath></defs>
<text class="eyebrow" x="24" y="38">Languages, average share per repo</text>
<g clip-path="url(#bar)">${bar}</g>
${legend}`;
  return svg(W, H, t, body, {
    label: `Languages, average share per ${PRIVATE ? '' : 'public '}repository: ${d.langs.map((l) => `${l.name} ${l.pct.toFixed(1)}%`).join(', ')}`,
  });
}

// ───────────────────────────── skyline ─────────────────────────────
// One bar per day, weeks left to right, Sunday at the back.
function skyline(t, d) {
  const W = 880, H = 256;
  const STEP = 14.4, BW = 11, DX = 5.6, DY = 4.8, FX = 4.6, FY = 3.9, OY = 208;
  const OX = (W - (d.weeks.length * STEP + 6 * DX + BW + FX - (STEP - BW))) / 2;
  const max = Math.max(1, ...d.days.map((x) => x.count));

  let tiles = '', bars = '';
  for (let dow = 0; dow < 7; dow++) {
    d.weeks.forEach((week, w) => {
      const cell = week.find((x) => x.dow === dow);
      if (!cell) return;
      const X = f(OX + w * STEP + (6 - dow) * DX), Y = f(OY - (6 - dow) * DY);
      if (!cell.count) { tiles += `M${X} ${Y}h${BW}l${FX} -${FY}h-${BW}z`; return; }
      const h = f(6 + 86 * (cell.count / max) ** 0.55);
      bars += `<g><path class="f${cell.level}" d="M${X} ${Y}h${BW}v-${h}h-${BW}z"/><path class="s${cell.level}" d="M${f(X + BW)} ${Y}l${FX} -${FY}v-${h}l-${FX} ${FY}z"/><path class="t${cell.level}" d="M${X} ${f(Y - h)}h${BW}l${FX} -${FY}h-${BW}z"/></g>`;
    });
  }

  let months = '', last = -9, prev = '';
  d.weeks.forEach((week, w) => {
    const mm = week[0].date.slice(5, 7);
    if (mm !== prev && w - last >= 3 && w < d.weeks.length - 1) {
      months += `<text class="mute" x="${f(OX + w * STEP)}" y="${OY + 24}" font-size="12">${MONTHS[+mm - 1]}</text>`;
      last = w;
    }
    prev = mm;
  });

  const legend = t.ramp.map((c, i) => `<rect x="${W - 139 + i * 15}" y="28.5" width="10" height="10" rx="3" fill="${c}"/>`).join('');
  const css =
    [1, 2, 3, 4].map((l) => `.t${l}{fill:${t.ramp[l]}}.f${l}{fill:${shade(t.ramp[l], t.front)}}.s${l}{fill:${shade(t.ramp[l], t.side)}}`).join('');
  const body = `
<text class="eyebrow" x="28" y="38">Contributions, day by day</text>
<text class="mute" x="${W - 145}" y="38" font-size="12" text-anchor="end">Less</text>${legend}<text class="mute" x="${W - 28}" y="38" font-size="12" text-anchor="end">More</text>
<path d="${tiles}" fill="${t.ramp[0]}" stroke="${t.tileEdge}" stroke-width=".6"/>
${bars}
${months}`;
  return svg(W, H, t, body, { css, label: `Contributions day by day over the last year, ${d.total} in total` });
}

// ───────────────────────────── project cards ─────────────────────────────
function project(t, p) {
  const W = 460, H = 186;
  let lines = p.blurb ? wrap(p.blurb, 58) : [];
  if (lines.length > 3) lines = [...lines.slice(0, 2), `${lines[2].replace(/[\s,.;:]+$/, '')}…`];
  const facts = [
    p.commits > 0 && `${p.commits} ${p.commits === 1 ? 'commit' : 'commits'} by me`,
    p.stars > 0 && `${p.stars} ${p.stars === 1 ? 'star' : 'stars'}`,
  ].filter(Boolean);
  const body = `
${p.lang ? `<circle cx="29" cy="31.5" r="4.5" fill="${p.lang.color ?? t.mute}"/><text class="eyebrow" x="41" y="36">${esc(p.lang.name)}</text>` : ''}
${p.role ? `<text class="${p.private ? 'mute' : 'accent'}" x="${W - 24}" y="36" font-size="12.5" font-weight="600" text-anchor="end">${esc(p.role)}</text>` : ''}
<text class="big" x="24" y="68" font-size="20">${esc(p.title)}</text>
${lines.map((l, i) => `<text class="mute" x="24" y="${93 + i * 19}" font-size="13">${esc(l)}</text>`).join('\n')}
<text class="mute num" x="24" y="${H - 22}" font-size="12.5">${esc(facts.join('  ·  '))}</text>
${p.private ? '' : `<circle cx="${W - 37}" cy="${H - 31}" r="13" fill="${t.chip}"/>
<path d="M${W - 41.5} ${H - 26.5}l9 -9m-6.5 0h6.5v6.5" fill="none" stroke="${t.ink}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`}`;
  return svg(W, H, t, body, { label: `${p.title}: ${p.blurb}` });
}

// ───────────────────────────── main ─────────────────────────────
const slug = (repo) => repo.toLowerCase().replace(/[^a-z0-9]+/g, '-');
async function draw(data) {
await mkdir(OUT, { recursive: true });
for (const old of await readdir(OUT)) if (old.endsWith('.svg')) await rm(join(OUT, old));
for (const [name, t] of Object.entries(THEMES)) {
  const files = {
    masthead: masthead(t, data),
    figures: figures(t, data),
    languages: languages(t, data),
    skyline: skyline(t, data),
    ...Object.fromEntries(data.projects.map((p) => [`card-${slug(p.repo)}`, project(t, p)])),
  };
  for (const [file, content] of Object.entries(files)) await writeFile(join(OUT, `${file}-${name}.svg`), content);
}

// The README parts that depend on the data sit between marker comments and are rewritten here.
const readmePath = join(ROOT, 'README.md');
const readme = await readFile(readmePath, 'utf8');
let next = readme;
const block = (name, lines, align = ' align="center"') => {
  const START = `<!-- ${name}:start -->`, END = `<!-- ${name}:end -->`;
  const a = next.indexOf(START), b = next.indexOf(END);
  if (a < 0 || b < a) throw new Error(`README.md needs ${START} and ${END}.`);
  const inner = lines.length ? `\n<p${align}>\n${lines.join('\n')}\n</p>\n` : '\n';
  next = next.slice(0, a + START.length) + inner + next.slice(b);
};
const headline = `<picture><source media="(prefers-color-scheme: dark)" srcset="assets/masthead-dark.svg"><img src="assets/masthead-light.svg" width="100%" alt="${esc(`${NAME}. ${TAGLINE.join(' ')}`)}"></picture>`;
block('headline', [LINK ? `<a href="${esc(LINK.url)}" title="${esc(LINK.label)}">${headline}</a>` : headline], '');
block('projects', data.projects.map((p) => {
  const file = `assets/card-${slug(p.repo)}`;
  const tip = `${p.repo}, ${p.commits} ${p.commits === 1 ? 'commit' : 'commits'} by me`;
  const picture = `<picture><source media="(prefers-color-scheme: dark)" srcset="${file}-dark.svg"><img src="${file}-light.svg" width="49%" alt="${esc(p.blurb ? `${p.title}: ${p.blurb}` : p.title)}"></picture>`;
  return p.private ? `  ${picture}` : `  <a href="https://github.com/${p.repo}" title="${esc(tip)}">${picture}</a>`;
}));
if (next !== readme) await writeFile(readmePath, next);

for (const p of data.projects) console.log(`${String(p.commits).padStart(5)} commits  ${p.repo}`);

console.log(`\n${LOGIN}: ${data.total} contributions on ${data.active} of ${data.days.length} days, longest streak ${data.longest}` +
  (!PRIVATE ? '' : data.shared ? ' (the calendar from GitHub already included private work)' : ` (${data.added} of them rebuilt from private repos, which made ${data.newDays} more days active)`));
}

const data = await load();
if (data) await draw(data);
