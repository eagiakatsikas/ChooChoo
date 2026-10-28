// Now: what should I catch? Your commute the right way round (from where you are, or failing
// that the time of day) with the next good train and when to leave; then the stations and
// bus stops nearest you; then everything you've starred.
//
// Everything it needs from the rest of the app comes in through `ctx`.

const REFRESH_MS = 30000;
const WALK_MPS = 1.3; // ~4.7 km/h, a brisk-but-normal walk
const WALK_DETOUR = 1.3; // streets aren't straight lines

export function createHome(ctx) {
  const el = document.getElementById('home');
  const body = document.getElementById('homeBody');
  let timer = null;
  // Where you were last (kept on this phone): lets Nearby show at once while the phone finds you
  let here = (() => {
    const h = ctx.store.get('lastHere', null);
    return h && Date.now() - h.at < 30 * 60000 ? h : null;
  })(); // { la, lo, at }
  let flipped = ctx.store.get('commuteFlip', null); // { until, flip }
  const extras = []; // render functions for later sections (alerts, disruption, reliability)

  const esc = ctx.esc;

  function metres(la, lo, s) {
    const x = (s.lo - lo) * Math.cos((la * Math.PI) / 180) * 111320;
    const y = (s.la - la) * 110574;
    return Math.hypot(x, y);
  }

  // Where you are comes from the app's one location watch (shared with the map's blue dot),
  // so the phone is asked at most once per visit
  let locFailed = false;
  function locate(ask = false) {
    if (!navigator.geolocation || !ctx.startMe(ask)) {
      locFailed = true;
      render();
    }
  }
  function setHere(p, denied = false) {
    if (!p) {
      if (!here) {
        locFailed = true;
        render();
      }
      return;
    }
    const moved = !here || Math.hypot(here.la - p.la, (here.lo - p.lo) * 0.62) > 0.0015; // ~150 m
    const stale = here && Date.now() - here.at > 5 * 60000;
    if (here && !moved && !stale) {
      here.at = Date.now(); // still here: keep it current for the walking time
      return;
    }
    here = { la: p.la, lo: p.lo, at: Date.now() };
    ctx.store.set('lastHere', here); // stays on this phone
    locFailed = false;
    if (!el.hidden) refresh(); // the direction may have changed, so fetch that board too
  }

  /** Your two commute stations: as set up, or else your first saved route. */
  function pair() {
    const c = ctx.commute && ctx.commute();
    if (c) return { a: c.home, b: c.work, set: true };
    const f = ctx.favs().find((x) => x.t);
    const a = f && ctx.byCrs(f.f);
    const b = f && ctx.byCrs(f.t);
    return a && b ? { a, b, set: false } : null;
  }

  /** Which way round to show the commute, and why. */
  function commute() {
    const pr = pair();
    if (!pr) return null;
    const { a, b } = pr;
    let rev = false;
    let why;
    if (here && Date.now() - here.at < 15 * 60000) {
      rev = metres(here.la, here.lo, b) < metres(here.la, here.lo, a);
      why = 'of where you are';
    } else {
      const h = new Date().getHours();
      rev = h >= 12; // mornings from home, afternoons and evenings from work
      why = h >= 12 ? 'it’s the afternoon' : 'it’s the morning';
    }
    if (flipped && flipped.until > Date.now()) {
      rev = flipped.rev;
      why = 'you swapped it';
    }
    const from = rev ? b : a;
    const to = rev ? a : b;
    return { from, to, why };
  }

  function walkMins(s) {
    if (!here || Date.now() - here.at > 15 * 60000) return null;
    const m = (metres(here.la, here.lo, s) * WALK_DETOUR) / WALK_MPS / 60;
    return Math.max(1, Math.round(m));
  }

  let there = null; // { crs, at, options } from TfL's journey planner

  async function fetchThere(st) {
    if (!here) return;
    try {
      const res = await fetch(`${ctx.WORKER}/api/getthere?la=${here.la.toFixed(5)}&lo=${here.lo.toFixed(5)}&crs=${st.c}`);
      const d = await res.json();
      there = { crs: st.c, at: Date.now(), options: d.options || [] };
    } catch {
      there = { crs: st.c, at: Date.now(), options: [] };
    }
  }

  /** How long to get to the station, and how: a short walk, or TfL's quickest route. */
  function travel(st) {
    const walk = walkMins(st);
    if (walk == null) return null;
    if (walk <= 10) return { mins: walk, how: 'walk', text: `${walk} min walk` };
    const opts = there && there.crs === st.c ? there.options : null;
    if (opts && opts.length) {
      const b = opts[0];
      return { mins: b.mins, how: b.walkOnly ? 'walk' : 'ride', text: b.walkOnly ? `${b.mins} min walk` : `${b.mins} min by ${b.summary}`, options: opts };
    }
    return walk <= 60 ? { mins: walk, how: 'walk', text: `${walk} min walk` } : null;
  }

  // Sections below the main card fold away; remember which ones you've opened
  const openFolds = new Set(ctx.store.get('homeFolds', []));
  function fold(id, title, inner, hint = '') {
    if (!inner) return '';
    return `<details class="fold" data-fold="${id}" ${openFolds.has(id) ? 'open' : ''}><summary><span>${title}</span>${hint ? `<small>${hint}</small>` : ''}</summary><div class="fold-body">${inner}</div></details>`;
  }
  body.addEventListener(
    'toggle',
    (e) => {
      const d = e.target;
      if (!d.dataset || !d.dataset.fold) return;
      if (d.open) openFolds.add(d.dataset.fold);
      else openFolds.delete(d.dataset.fold);
      ctx.store.set('homeFolds', [...openFolds]);
    },
    true,
  );

  /** Getting to the station: TfL's best few routes, door to station. */
  function thereSection(st, tr) {
    if (!tr || !tr.options || tr.how === 'walk' && tr.options.length < 2) return '';
    const legText = (o) =>
      o.legs
        .filter((l) => l.mode !== 'walking' || l.mins >= 5)
        .map((l) => (l.mode === 'walking' ? `walk ${l.mins} min` : `${esc(l.name)} from ${esc(l.from.replace(/ (Underground|Rail|DLR|Overground) Station$/i, ''))}${l.disrupted ? ` ${ctx.icon ? ctx.icon.warn : '!'}` : ''}`))
        .join(' → ');
    return `<div class="h-bus"><h3 class="h-head">Getting to ${esc(ctx.short(st.n))}</h3><ul>${tr.options
      .map((o) => `<li><span class="h-mins">${o.mins}<small>min</small></span><span><b>${esc(o.summary)}</b><small>${legText(o) || 'Walk all the way'}</small></span></li>`)
      .join('')}</ul></div>`;
  }

  /** Minutes until a "HH:MM" time today (handles just after midnight). */
  function minsUntil(hhmm) {
    if (!/^\d\d:\d\d$/.test(hhmm || '')) return null;
    const now = new Date(ctx.now());
    let d = Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3)) - (now.getHours() * 60 + now.getMinutes());
    if (d < -720) d += 1440;
    return d;
  }

  // Boards are kept on the phone for half an hour, so Now has something to show straight away
  // (each says how old it is) and still works with poor signal
  const BOARD_KEEP_MS = 30 * 60000;
  const boards = new Map(
    Object.entries(ctx.store.get('nowBoards', {})).filter(([, d]) => d && Date.now() - d._at < BOARD_KEEP_MS),
  ); // "FROM|TO" → data
  let boardsSaveTimer = null;
  function saveBoards() {
    clearTimeout(boardsSaveTimer);
    boardsSaveTimer = setTimeout(() => {
      const keep = [...boards].filter(([, d]) => Date.now() - d._at < BOARD_KEEP_MS).slice(-12);
      ctx.store.set('nowBoards', Object.fromEntries(keep));
    }, 1000);
  }
  let busTo = null; // { crs, at, options }
  const hist = new Map(); // "FROM|TO" → reliability summary

  async function fetchHistory(c) {
    const watch = ctx
      .favs()
      .filter((f) => f.t)
      .flatMap((f) => [`${f.f}-${f.t}`, `${f.t}-${f.f}`])
      .slice(0, 10)
      .join(',');
    try {
      const res = await fetch(`${ctx.WORKER}/api/history?f=${c.from.c}&t=${c.to.c}&watch=${watch}`);
      hist.set(`${c.from.c}|${c.to.c}`, await res.json());
    } catch {}
  }

  /** How this route has been running lately. */
  function reliability(c) {
    const h = hist.get(`${c.from.c}|${c.to.c}`);
    if (!h) return '';
    const w = h.week;
    if (!w || w.trains < 3) {
      return `<div class="h-rel"><h3 class="h-head">How reliable it’s been</h3><p class="h-why">Choo Choo has started keeping track of this route. Check back in a day or two to see how often its trains run late.</p></div>`;
    }
    const pct = Math.round((w.onTime / w.trains) * 100);
    const usual = h.times
      .filter((x) => x.trains >= 2 && (x.late || x.cancelled))
      .sort((a, b) => b.late + b.cancelled - (a.late + a.cancelled))
      .slice(0, 3)
      .map((x) => `<li><b>${esc(x.s)}</b> late ${x.late} of ${x.trains} days${x.cancelled ? `, cancelled ${x.cancelled}` : ''}${x.worst >= 3 ? ` (up to ${x.worst} min)` : ''}</li>`)
      .join('');
    return `<div class="h-rel"><h3 class="h-head">How reliable it’s been (last 7 days)</h3>
      <div class="h-meter" role="img" aria-label="${pct}% on time"><span style="width:${pct}%"></span></div>
      <p class="h-relsum"><b>${pct}% on time</b> · ${w.trains} trains · ${w.late} late${w.late ? ` (avg ${w.avgLate} min)` : ''}${w.cancelled ? ` · ${w.cancelled} cancelled` : ''}</p>
      ${usual ? `<ul class="h-usual">${usual}</ul>` : ''}</div>`;
  }

  async function fetchBusTo(st) {
    if (!here) return;
    try {
      const res = await fetch(`${ctx.WORKER}/api/busto?la=${here.la.toFixed(5)}&lo=${here.lo.toFixed(5)}&crs=${st.c}`);
      const d = await res.json();
      if (d.options) busTo = { crs: st.c, at: Date.now(), options: d.options };
    } catch {}
  }

  /** "Or get the bus": shown when the walk to the station is a long one. */
  function busSection(st, walk) {
    if (walk == null || walk < 12 || !busTo || busTo.crs !== st.c || !busTo.options.length) return '';
    const rows = busTo.options
      .slice(0, 2)
      .map((o) => {
        const due = o.due.length ? o.due.map((m) => (m <= 0 ? 'due' : `${m} min`)).join(', ') : 'no times yet';
        return `<li><span class="bp-num">${esc(o.route)}</span><span><b>From ${esc(o.stop)}</b> (${o.walk} min walk) · ${due}<small>${o.ride} min ride to ${esc(o.off)}${
          o.atStation != null ? ` · at the station in about ${o.atStation} min` : ''
        }</small></span></li>`;
      })
      .join('');
    return `<div class="h-bus"><h3 class="h-head">Or take the bus</h3><ul>${rows}</ul></div>`;
  }

  /** A board's trains that haven't left yet (a kept board can be a while old). */
  function upcoming(d) {
    if (!d) return d;
    if (Date.now() - (d._at || 0) < 90000) return d;
    return { ...d, rows: d.rows.filter((r) => (minsUntil(r.etdTime || r.std) ?? 0) >= -1) };
  }

  async function fetchBoard(from, to) {
    try {
      const res = await fetch(`${ctx.WORKER}/api/board?from=${from}&to=${to}`);
      const d = await res.json();
      if (!d.error) {
        boards.set(`${from}|${to}`, { ...d, _at: Date.now() });
        saveBoards();
      }
    } catch {}
  }

  function trainRow(r, walk) {
    const [exp, cls] = ctx.expText(r);
    const dep = r.etdTime || r.std;
    const until = minsUntil(dep);
    let leave = '';
    if (walk != null && until != null && !r.cancelled) {
      const l = until - walk - 2; // a couple of minutes to find the platform
      leave = l > 0 ? `Leave in ${l} min` : l > -2 ? 'Leave now' : 'Too late to walk';
    }
    const plat = r.plat
      ? `<span class="b-plat ${r.platLive ? '' : 'planned'}"><b>${esc(r.plat)}</b><small>${r.platLive ? 'Platform' : 'Planned'}</small></span>`
      : `<span class="b-plat planned"><b>–</b><small>Platform</small></span>`;
    const bits = [
      r.etaTime || r.sta ? `Arrives ${r.etaTime || r.sta}` : '',
      r.mins != null ? `${r.mins} min` : '',
      r.coaches ? `${r.coaches} coaches` : '',
    ].filter(Boolean);
    if (r._missed) bits.unshift('Too soon to make');
    return { html: `<button class="b-row ${r.best ? 'best' : ''} ${r.cancelled ? 'cancelled' : ''} ${r._missed ? 'missed' : ''}" type="button" ${r.id ? `data-id="${esc(r.id)}"` : ''}>
      <span><span class="b-time">${esc(r.std)}</span><span class="b-exp ${cls}">${exp}</span></span>
      <span><span class="b-dest">${esc(r.dest)}${r.best ? '<span class="b-tag">Best</span>' : ''}</span><span class="b-sub">${bits.join(' · ')}</span></span>
      ${plat}
    </button>`, leave, until };
  }

  /** "Leave in 6 min" for the best train, or for the first one you can still make. */
  function leaveLine(rows, best, tr) {
    if (!tr) return '';
    const walk = tr.mins;
    const verb = tr.how === 'walk' ? 'walk to' : 'make';
    const spare = (r) => {
      const u = minsUntil(r.etdTime || r.std);
      return u == null ? null : u - walk - 2; // a couple of minutes to find the platform
    };
    const b = spare(best);
    if (b != null && b >= 0) return `<p class="h-leave">${b === 0 ? 'Leave now' : `Leave in ${b} min`}<small> · ${esc(tr.text)}</small></p>`;
    const next = rows.find((r) => !r.cancelled && (spare(r) ?? -1) >= 0);
    if (!next) return `<p class="h-leave">It’s ${tr.text} to the station: too far for the next few trains</p>`;
    const s2 = spare(next);
    return `<p class="h-leave">Too late to ${verb} this one. ${s2 === 0 ? 'Leave now' : `Leave in ${s2} min`} for the ${esc(next.std)}</p>`;
  }

  // ----- Places near you and places you've starred -----
  let near = null; // { la, lo, stops: [...] } from the worker
  const pin = (kind) => `<span class="pin ${kind}">${kind === 'rail' ? ctx.icon.rail : ctx.icon.stop}</span>`;

  /** The two nearest stations (within a walk or a short ride) and the two nearest bus stops. */
  function nearby() {
    if (!here) return [];
    const list = ctx.stations() || [];
    const st = list
      .map((s) => [metres(here.la, here.lo, s), s])
      .filter(([d]) => d < 2500)
      .sort((a, b) => a[0] - b[0])
      .slice(0, 2)
      .map(([d, s]) => ({ kind: 'stn', d, s }));
    const sp = (near && near.stops ? near.stops : [])
      .filter((x) => x.d < 500)
      .slice(0, 2)
      .map((x) => ({ kind: 'stop', d: x.d, x }));
    return [...st, ...sp].sort((a, b) => a.d - b.d);
  }

  const dist = (m) => (m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`);

  /** The next few trains from a board, as small chips. */
  function trainChips(d, to) {
    if (!d) return '<span class="chip quiet">…</span>';
    const rows = d.rows.filter((r) => !r.cancelled).slice(0, 3);
    if (!rows.length) return `<span class="chip quiet">${to ? 'No direct trains soon' : 'No trains soon'}</span>`;
    return rows
      .map((r) => {
        const late = r.etdTime && r.etdTime !== r.std;
        const where = to ? `arr ${esc(r.etaTime || r.sta || '')}` : esc(ctx.short(r.dest));
        return `<span class="chip"><b class="${late ? 'late' : ''}">${esc(late ? r.etdTime : r.std)}</b> ${where}${r.plat ? ` · ${esc(r.plat)}` : ''}</span>`;
      })
      .join('');
  }

  /** What's due at a bus stop, a chip per route. */
  function busChips(d) {
    if (!d) return '<span class="chip quiet">…</span>';
    if (d.error || !d.rows.length) return '<span class="chip quiet">Nothing due soon</span>';
    const byRoute = new Map();
    for (const r of d.rows) (byRoute.get(r.route) || byRoute.set(r.route, []).get(r.route)).push(r.m);
    return [...byRoute]
      .slice(0, 4)
      .map(([rt, ms]) => {
        const t = ms.slice(0, 2).map((m) => (m <= 0 ? 'due' : m));
        return `<span class="chip">${ctx.busBadge(rt)} ${t.join(', ')}${t[t.length - 1] === 'due' ? '' : ' min'}</span>`;
      })
      .join('');
  }

  function stationCard(f, t, side) {
    const a = ctx.byCrs(f);
    const b = t && ctx.byCrs(t);
    if (!a) return '';
    return `<button class="place-card" type="button" data-board="${f}|${t || ''}">
      <span class="pc-head">${pin('rail')}<b>${esc(b ? `${ctx.short(a.n)} → ${ctx.short(b.n)}` : a.n)}</b><span class="pc-side">${side}</span></span>
      <span class="chips">${trainChips(upcoming(boards.get(`${f}|${t || ''}`)), t)}</span></button>`;
  }

  function stopCard(id, name, side, la, lo) {
    const d = ctx.stopBoard(id);
    return `<button class="place-card" type="button" data-stop="${esc(id)}" data-la="${la ?? d?.la ?? ''}" data-lo="${lo ?? d?.lo ?? ''}">
      <span class="pc-head">${pin('bus')}<b>${esc(d ? d.name : name)}</b><span class="pc-side">${side}</span></span>
      ${d && d.towards ? `<span class="pc-sub">towards ${esc(d.towards)}</span>` : ''}
      <span class="chips">${busChips(d)}</span></button>`;
  }

  function nearbyHtml() {
    let inner;
    if (!here) {
      inner = locFailed
        ? `<div class="h-card h-quiet"><p>See the stations and bus stops nearest you, with what’s leaving next.</p><button class="h-btn" type="button" data-me="1">Use my location</button></div>`
        : '<p class="h-quiet-line">Finding where you are…</p>';
    } else {
      const list = nearby();
      inner = list.length
        ? list.map((p) => (p.kind === 'stn' ? stationCard(p.s.c, null, dist(p.d)) : stopCard(p.x.i, p.x.n, dist(p.d), p.x.la, p.x.lo))).join('')
        : '<p class="h-quiet-line">No stations or bus stops close by.</p>';
    }
    return `<h3 class="sec-head"><span>Nearby</span>${here ? '<button class="h-link" type="button" data-go="map">See on map</button>' : ''}</h3>${inner}`;
  }

  function starredHtml(skip) {
    const star = `<span class="star-on">${ctx.icon.starOn}</span>`;
    const cards = [];
    for (const f of ctx.favs()) {
      if (skip && f.t && ((f.f === skip.a.c && f.t === skip.b.c) || (f.f === skip.b.c && f.t === skip.a.c))) continue; // that's your commute, above
      cards.push(stationCard(f.f, f.t, star));
    }
    for (const f of ctx.stopFavs()) cards.push(stopCard(f.i, f.n, star));
    const routes = ctx.busFavs();
    if (routes.length) {
      cards.push(`<div class="place-card static"><span class="pc-head">${pin('bus')}<b>Bus routes</b><span class="pc-side">${star}</span></span>
        <span class="chips">${routes.map((r) => `<button class="chip" type="button" data-route="${esc(r)}">${ctx.busBadge(ctx.routeName(r))}</button>`).join('')}</span></div>`);
    }
    if (!cards.length) return `<h3 class="sec-head"><span>Starred</span></h3><p class="h-quiet-line">Open a station, bus stop or bus route and tap <b>Star</b> to keep it here.</p>`;
    return `<h3 class="sec-head"><span>Starred</span></h3>${cards.join('')}`;
  }

  function render() {
    if (el.hidden) return;
    const loc = document.getElementById('nowLoc');
    if (loc) {
      const n = here && (ctx.stations() || []).reduce((best, s) => (!best || metres(here.la, here.lo, s) < metres(here.la, here.lo, best) ? s : best), null);
      loc.innerHTML = n ? `<span class="lamp" aria-hidden="true"></span>near ${esc(ctx.short(n.n))}` : '';
    }
    const pr = pair();
    let html = '';
    if (!pr) {
      html += `<section class="h-card h-quiet">
        <p><b>Set up your commute</b> and Now shows your next train the right way round, with its platform and when to leave.</p>
        <button class="h-btn" type="button" data-go="setup">Set up your commute</button>
      </section>`;
    }
    const c = commute();
    if (c) {
      const d = upcoming(boards.get(`${c.from.c}|${c.to.c}`));
      const walk = walkMins(c.from);
      const tr = travel(c.from);
      const autoOn = ctx.alerts() && ctx.alerts().autoOn();
      html += `<section class="h-card">
        <div class="h-route">
          <div><small>Your commute</small><b>${esc(ctx.short(c.from.n))} → ${esc(ctx.short(c.to.n))}</b></div>
          <button class="h-swap" type="button" aria-label="Other way round" title="This way round because ${esc(c.why)}. Tap to swap.">${ctx.icon ? ctx.icon.swap : '⇄'}</button>
        </div>`;
      if (!d) html += '<p class="b-empty">Checking departures…</p>';
      else if (!d.rows.length) html += `<p class="b-empty">No direct trains in the next two hours.</p>`;
      else {
        // Knowing how long it takes you to get there, the train to show is the one that gets
        // you in soonest among those you can still make (not just the one leaving first)
        const spare = (r) => {
          const u = minsUntil(r.etdTime || r.std);
          return tr && u != null ? u - tr.mins - 2 : null;
        };
        const missed = (r) => tr && (spare(r) ?? -1) < 0;
        let best = d.rows.find((r) => r.best) || d.rows[0];
        if (tr) {
          const ok = d.rows.filter((r) => !r.cancelled && !missed(r));
          if (ok.length) best = ok.reduce((a, b) => ((minsUntil(b.etaTime || b.sta) ?? 9999) < (minsUntil(a.etaTime || a.sta) ?? 9999) ? b : a));
        }
        const shown = d.rows.filter((r) => !r.cancelled || r === best);
        const after = shown.slice(shown.indexOf(best) + 1, shown.indexOf(best) + 3).map((r) => ({ ...r, best: false, _missed: missed(r) }));
        const top = trainRow(best, walk);
        const [exp, cls] = ctx.expText(best);
        const alertOn = best.id && ctx.alerts() && ctx.alerts().has(best.id);
        html += `<button class="h-next" type="button" ${best.id ? `data-id="${esc(best.id)}"` : ''} data-crs="${c.from.c}">
          <span class="h-big"><span class="h-time">${esc(best.etdTime || best.std)}</span>
            <span class="h-in">${top.until != null ? (top.until <= 0 ? 'due now' : `in ${top.until} min`) : ''}<small class="b-exp ${cls}">${best.cancelled ? 'Cancelled' : exp}${best.etaTime || best.sta ? ` · arr ${esc(best.etaTime || best.sta)}` : ''}</small></span></span>
          <span class="h-plat"><b>${esc(best.plat || '–')}</b><small>${best.plat ? (best.platLive ? 'Platform' : 'Planned') : 'Platform'}</small></span>
        </button>
        ${leaveLine(d.rows, best, tr)}
        <div class="acts">${
          best.id && ctx.alerts() ? `<button class="act" type="button" data-alert="${esc(best.id)}" data-crs="${c.from.c}" aria-pressed="${Boolean(alertOn)}">${ctx.icon.bell} ${alertOn ? 'Alert on' : `Alert me`}</button>` : ''
        }<button class="act" type="button" data-auto="1" aria-pressed="${Boolean(autoOn)}" title="Weekdays, 6–10am from home and 4–8pm from work, Choo Choo picks your next good train and alerts you about it">${ctx.icon.bell} ${autoOn ? 'Every weekday: on' : 'Every weekday'}</button></div>
        ${after.length ? `<div class="h-later">${after.map((r) => trainRow(r, walk).html).join('')}</div>` : ''}
        <p class="b-foot">${d.source === 'national-rail' ? 'Live from National Rail' : 'Timetabled platforms until announced'} · ${ctx.fresh ? ctx.fresh(d._at || Date.now()) : ''} · <button class="h-link" type="button" data-board="${c.from.c}|${c.to.c}">Full board</button></p>`;
      }
      html += '</section>';
      // Disruption on your trains, then the extras folded away
      const dz = ctx.disruptionNote && d ? ctx.disruptionNote(d.rows.map((r) => r.op)) : '';
      if (dz) html += dz;
      html += fold('there', `Getting to ${esc(ctx.short(c.from.n))}`, thereSection(c.from, tr) || (tr && tr.options ? '' : busSection(c.from, walk)), tr ? esc(tr.text) : '');
      const h7 = hist.get(`${c.from.c}|${c.to.c}`);
      const pct = h7 && h7.week && h7.week.trains >= 3 ? `${Math.round((h7.week.onTime / h7.week.trains) * 100)}% on time` : '';
      html += fold('rel', 'How reliable it’s been', reliability(c), pct);
    }
    html += nearbyHtml();
    html += starredHtml(pr);
    body.innerHTML = html;
  }

  async function fetchNear() {
    if (!here) return;
    if (near && Math.hypot(near.la - here.la, near.lo - here.lo) < 0.001) return;
    try {
      const res = await fetch(`${ctx.WORKER}/api/stops?la=${here.la.toFixed(5)}&lo=${here.lo.toFixed(5)}`);
      const list = await res.json();
      near = { la: here.la, lo: here.lo, stops: Array.isArray(list) ? list : [] };
    } catch {}
  }

  let busy = false;
  let again = false; // asked for while busy (e.g. your location arrived): go round once more
  async function refresh() {
    if (el.hidden) return;
    if (busy) return void (again = true);
    busy = true;
    again = false;
    try {
      const c = commute();
      const jobs = [];
      if (c) jobs.push(fetchBoard(c.from.c, c.to.c));
      if (c && (walkMins(c.from) ?? 0) > 10) {
        // TfL's journey planner first; the simple bus finder only if that has nothing
        jobs.push(fetchThere(c.from).then(() => (there.options.length ? null : fetchBusTo(c.from))));
      }
      if (c) jobs.push(fetchHistory(c));
      // Your starred stations, routes and stops
      for (const f of ctx.favs().slice(0, 8)) jobs.push(fetchBoard(f.f, f.t || ''));
      for (const f of ctx.stopFavs().slice(0, 6)) jobs.push(ctx.fetchStop(f.i));
      // What's near you
      jobs.push(
        fetchNear().then(() => {
          const list = nearby();
          return Promise.all(list.map((p) => (p.kind === 'stn' ? fetchBoard(p.s.c, '') : ctx.fetchStop(p.x.i))));
        }),
      );
      render();
      await Promise.all(jobs.map((j) => j.then(render, () => {})));
      render();
    } finally {
      busy = false;
      if (again) refresh();
    }
  }

  body.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.classList.contains('h-swap')) {
      const c = commute();
      const pr = pair();
      const rev = c && pr && c.from.c !== pr.a.c;
      flipped = { rev: !rev, until: Date.now() + 4 * 3600000 };
      ctx.store.set('commuteFlip', flipped);
      refresh();
      return;
    }
    if (b.dataset.go === 'setup') return ctx.openSetup && ctx.openSetup();
    if (b.dataset.go) return ctx.setTab(b.dataset.go);
    if (b.dataset.me) {
      locFailed = false;
      render();
      return locate(true);
    }
    if (b.dataset.alert) {
      const a = ctx.alerts();
      const own = a.list().find((x) => x.key === b.dataset.alert);
      if (own) a.remove(own.id);
      else a.watch(b.dataset.alert, b.dataset.crs);
      return;
    }
    if (b.dataset.auto) return ctx.setAuto(!ctx.alerts().autoOn());
    if (b.dataset.route) return ctx.openRoute(b.dataset.route);
    if (b.dataset.stop) return ctx.openStop(b.dataset.stop, Number(b.dataset.la) || null, Number(b.dataset.lo) || null);
    if (b.dataset.board) {
      const [from, to] = b.dataset.board.split('|');
      return ctx.openBoard(from, to || null);
    }
    if (b.dataset.id && !ctx.showTrain(b.dataset.id, b.dataset.crs || b.closest('.h-card')?.querySelector('[data-crs]')?.dataset.crs)) {
      const sub = b.querySelector('.b-sub, .h-in small');
      if (sub && !/not on the map/.test(sub.textContent)) sub.insertAdjacentHTML('beforeend', ' · not on the map yet');
    }
  });

  return {
    async open(on) {
      el.hidden = !on;
      clearInterval(timer);
      if (!on) return;
      try {
        await ctx.loadStations();
      } catch {}
      locate();
      refresh();
      timer = setInterval(refresh, REFRESH_MS);
    },
    isOpen: () => !el.hidden,
    render,
    refresh,
    /** Later features add their own sections to Home. */
    addSection(fn) {
      extras.push(fn);
    },
    here: () => here,
    setHere,
  };
}
