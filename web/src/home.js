// Home: your commute at a glance. Picks your saved route in the direction you're likely
// travelling (from where you are, or failing that the time of day), and shows the next
// good train, when to leave, and your other saved routes.
//
// Everything it needs from the rest of the app comes in through `ctx`.

const REFRESH_MS = 30000;
const WALK_MPS = 1.3; // ~4.7 km/h, a brisk-but-normal walk
const WALK_DETOUR = 1.3; // streets aren't straight lines

export function createHome(ctx) {
  const el = document.getElementById('home');
  const body = document.getElementById('homeBody');
  let timer = null;
  let here = null; // { la, lo, at }
  let flipped = ctx.store.get('commuteFlip', null); // { until, flip }
  const extras = []; // render functions for later sections (alerts, disruption, reliability)

  const esc = ctx.esc;

  function metres(la, lo, s) {
    const x = (s.lo - lo) * Math.cos((la * Math.PI) / 180) * 111320;
    const y = (s.la - la) * 110574;
    return Math.hypot(x, y);
  }

  function locate() {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (p) => {
        here = { la: p.coords.latitude, lo: p.coords.longitude, at: Date.now() };
        refresh(); // the direction may have changed, so fetch that board too
      },
      () => {},
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 300000 },
    );
  }

  /** Your two commute stations: as set up, or else your first saved route. */
  function pair() {
    const c = ctx.commute && ctx.commute();
    if (c) return { a: c.home, b: c.work, set: true };
    const f = ctx.favs()[0];
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

  const boards = new Map(); // "FROM|TO" → data
  let busTo = null; // { crs, at, options }
  const hist = new Map(); // "FROM|TO" → reliability summary

  async function fetchHistory(c) {
    const watch = ctx
      .favs()
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

  async function fetchBoard(from, to) {
    try {
      const res = await fetch(`${ctx.WORKER}/api/board?from=${from}&to=${to}`);
      const d = await res.json();
      if (!d.error) boards.set(`${from}|${to}`, { ...d, _at: Date.now() });
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
    if (b != null && b >= 0) return `<p class="h-leave">${b === 0 ? 'Leave now' : `Leave in ${b} min`} to ${verb} this one</p>`;
    const next = rows.find((r) => !r.cancelled && (spare(r) ?? -1) >= 0);
    if (!next) return `<p class="h-leave">It’s ${tr.text} to the station: too far for the next few trains</p>`;
    const s2 = spare(next);
    return `<p class="h-leave">Too late to ${verb} this one. ${s2 === 0 ? 'Leave now' : `Leave in ${s2} min`} for the ${esc(next.std)}</p>`;
  }

  function render() {
    if (el.hidden) return;
    const h = new Date().getHours();
    document.getElementById('homeTitle').textContent = h < 5 ? 'Good evening' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
    const favs = ctx.favs();
    if (!pair()) {
      body.innerHTML = `<div class="h-empty">
        <p><b>Set up your commute to see it here.</b></p>
        <p>Choose your home and work stations, and Choo Choo shows the next good train the right way round, with its platform and when to leave.</p>
        <button class="h-btn" type="button" data-go="setup">Set up your commute</button>
      </div>` + extrasHtml();
      return;
    }
    const c = commute();
    let html = '';
    if (c) {
      const d = boards.get(`${c.from.c}|${c.to.c}`);
      const walk = walkMins(c.from);
      const tr = travel(c.from);
      html += `<section class="h-card">
        <div class="h-route">
          <div><small>Your commute</small><b>${esc(ctx.short(c.from.n))} → ${esc(ctx.short(c.to.n))}</b></div>
          <button class="h-swap" type="button" aria-label="Swap direction" title="Swap direction">${ctx.icon ? ctx.icon.swap : '⇄'}</button>
        </div>
        <p class="h-why">This way round because ${c.why}.${tr ? ` About ${esc(tr.text)} to ${esc(ctx.short(c.from.n))}.` : ''}</p>`;
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
        const from = Math.max(0, shown.indexOf(best) - 1); // one you've missed for context, then the rest
        const rows = shown.slice(from, from + 3).map((r) => ({ ...r, best: r === best, _missed: missed(r) }));
        const top = trainRow(best, walk);
        html += `<div class="h-next">
          <div class="h-big"><span class="h-time">${esc(best.etdTime || best.std)}</span>
            <span class="h-in">${top.until != null ? (top.until <= 0 ? 'due now' : `in ${top.until} min`) : ''}</span></div>
          <div class="h-plat"><b>${esc(best.plat || '–')}</b><small>${best.plat ? (best.platLive ? 'Platform' : 'Planned platform') : 'Platform not yet known'}</small></div>
        </div>
        ${leaveLine(d.rows, best, tr)}
        ${best.id && ctx.alerts() ? `<button class="h-alert" type="button" data-alert="${esc(best.id)}" data-crs="${c.from.c}" aria-pressed="${ctx.alerts().has(best.id)}">${ctx.alerts().has(best.id) ? 'Alert on for this train' : `Alert me about the ${esc(best.std)}`}</button>` : ''}
        <div class="board h-board">${rows.map((r) => trainRow(r, walk).html).join('')}</div>
        <p class="b-foot">${d.source === 'national-rail' ? 'Live times and platforms from National Rail' : 'Timetabled platforms until the station announces them'} · ${ctx.fresh ? ctx.fresh(d._at || Date.now()) : ''}</p>`;
      }
      html += `<div class="h-more"><button class="h-link" type="button" data-board="${c.from.c}|${c.to.c}">Full departures board</button><button class="h-link" type="button" data-board="${c.from.c}|">All trains from ${esc(ctx.short(c.from.n))}</button></div>`;
      html += '</section>';
      // Everything else folds away under the main card
      const dz = ctx.disruptionNote && d ? ctx.disruptionNote(d.rows.map((r) => r.op)) : '';
      if (dz) html += fold('dz', 'Disruption on your trains', dz, '');
      html += fold('there', `Getting to ${esc(ctx.short(c.from.n))}`, thereSection(c.from, tr) || (tr && tr.options ? '' : busSection(c.from, walk)), tr ? esc(tr.text) : '');
      const h7 = hist.get(`${c.from.c}|${c.to.c}`);
      const pct = h7 && h7.week && h7.week.trains >= 3 ? `${Math.round((h7.week.onTime / h7.week.trains) * 100)}% on time` : '';
      html += fold('rel', 'How reliable it’s been', reliability(c), pct);
    }
    // Other saved routes, one line each (not the commute itself)
    const pr = pair();
    const others = favs.filter((f) => !pr || !((f.f === pr.a.c && f.t === pr.b.c) || (f.f === pr.b.c && f.t === pr.a.c)));
    if (others.length) {
      let inner = '<ul class="h-routes">';
      for (const f of others) {
        const a = ctx.byCrs(f.f);
        const b = ctx.byCrs(f.t);
        if (!a || !b) continue;
        const d = boards.get(`${f.f}|${f.t}`);
        const r = d && (d.rows.find((x) => x.best) || d.rows[0]);
        const [exp, cls] = r ? ctx.expText(r) : ['', ''];
        inner += `<li><button type="button" data-board="${f.f}|${f.t}"><span class="h-r">${esc(ctx.short(a.n))} → ${esc(ctx.short(b.n))}</span>
          <span class="h-n">${r ? `${esc(r.std)} <span class="b-exp ${cls}">${exp}</span>${r.plat ? ` · plat ${esc(r.plat)}` : ''}` : d ? 'No direct trains soon' : '…'}</span></button></li>`;
      }
      inner += '</ul>';
      html += fold('others', 'Your other routes', inner, `${others.length}`);
    }
    body.innerHTML = html + extrasHtml();
  }

  /** Sections added by the rest of the app (bus stops, alerts), folded like the rest. */
  function extrasHtml() {
    return extras
      .map((f, i) => {
        const r = f();
        if (!r) return '';
        if (typeof r === 'string') return r;
        return fold(r.id || `x${i}`, r.title, r.html, r.hint || '');
      })
      .join('');
  }

  async function refresh() {
    if (el.hidden) return;
    const c = commute();
    const jobs = [];
    if (c) jobs.push(fetchBoard(c.from.c, c.to.c));
    if (c && (walkMins(c.from) ?? 0) > 10) {
      // TfL's journey planner first; the simple bus finder only if that has nothing
      jobs.push(fetchThere(c.from).then(() => (there.options.length ? null : fetchBusTo(c.from))));
    }
    if (c) jobs.push(fetchHistory(c));
    for (const f of ctx.favs().slice(0, 6)) jobs.push(fetchBoard(f.f, f.t));
    render();
    await Promise.all(jobs);
    render();
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
    if (b.dataset.alert) {
      const a = ctx.alerts();
      const own = a.list().find((x) => x.key === b.dataset.alert);
      if (own) a.remove(own.id);
      else a.watch(b.dataset.alert, b.dataset.crs);
      return;
    }
    if (b.dataset.board) {
      const [from, to] = b.dataset.board.split('|');
      return ctx.openBoard(from, to || null);
    }
    if (b.dataset.id && !ctx.showTrain(b.dataset.id, b.closest('.h-card')?.querySelector('[data-crs]')?.dataset.crs)) {
      b.querySelector('.b-sub')?.insertAdjacentHTML('beforeend', ' · not on the map yet');
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
  };
}
