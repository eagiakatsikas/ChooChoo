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
        render();
      },
      () => {},
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 300000 },
    );
  }

  /** Which way round to show the commute, and why. */
  function commute() {
    const favs = ctx.favs();
    if (!favs.length) return null;
    const f = favs[0];
    const a = ctx.byCrs(f.f);
    const b = ctx.byCrs(f.t);
    if (!a || !b) return null;
    let rev = false;
    let why;
    if (here && Date.now() - here.at < 15 * 60000) {
      rev = metres(here.la, here.lo, b) < metres(here.la, here.lo, a);
      why = 'from where you are';
    } else {
      const h = new Date().getHours();
      rev = h >= 12; // mornings as saved, afternoons and evenings the other way
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
    return m > 60 ? null : Math.max(1, Math.round(m));
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

  async function fetchBoard(from, to) {
    try {
      const res = await fetch(`${ctx.WORKER}/api/board?from=${from}&to=${to}`);
      const d = await res.json();
      if (!d.error) boards.set(`${from}|${to}`, d);
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
    return { html: `<button class="b-row ${r.best ? 'best' : ''} ${r.cancelled ? 'cancelled' : ''}" type="button" ${r.id ? `data-id="${esc(r.id)}"` : ''}>
      <span><span class="b-time">${esc(r.std)}</span><span class="b-exp ${cls}">${exp}</span></span>
      <span><span class="b-dest">${esc(r.dest)}${r.best ? '<span class="b-tag">Best</span>' : ''}</span><span class="b-sub">${bits.join(' · ')}</span></span>
      ${plat}
    </button>`, leave, until };
  }

  function render() {
    if (el.hidden) return;
    const h = new Date().getHours();
    document.getElementById('homeTitle').textContent = h < 5 ? 'Good evening' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
    const favs = ctx.favs();
    if (!favs.length) {
      body.innerHTML = `<div class="h-empty">
        <p><b>Save a route to see it here.</b></p>
        <p>Open Departures, choose where you’re going from and to (say Raynes Park to Waterloo), and tap ☆ Save route. Your first saved route becomes your commute: it shows here the right way round for the time of day, with the next good train and when to leave.</p>
        <button class="h-btn" type="button" data-go="departures">Open Departures</button>
      </div>` + extras.map((f) => f()).join('');
      return;
    }
    const c = commute();
    let html = '';
    if (c) {
      const d = boards.get(`${c.from.c}|${c.to.c}`);
      const walk = walkMins(c.from);
      html += `<section class="h-card">
        <div class="h-route">
          <div><small>Your commute</small><b>${esc(ctx.short(c.from.n))} → ${esc(ctx.short(c.to.n))}</b></div>
          <button class="h-swap" type="button" aria-label="Swap direction" title="Swap direction">⇄</button>
        </div>
        <p class="h-why">This way round because ${c.why}.${walk != null ? ` About ${walk} min walk to ${esc(ctx.short(c.from.n))}.` : ''}</p>`;
      if (!d) html += '<p class="b-empty">Checking departures…</p>';
      else if (!d.rows.length) html += `<p class="b-empty">No direct trains in the next two hours.</p>`;
      else {
        const rows = d.rows.filter((r) => !r.cancelled || r.best).slice(0, 4);
        const best = d.rows.find((r) => r.best) || rows[0];
        const top = trainRow(best, walk);
        html += `<div class="h-next">
          <div class="h-big"><span class="h-time">${esc(best.etdTime || best.std)}</span>
            <span class="h-in">${top.until != null ? (top.until <= 0 ? 'due now' : `in ${top.until} min`) : ''}</span></div>
          <div class="h-plat"><b>${esc(best.plat || '–')}</b><small>${best.plat ? (best.platLive ? 'Platform' : 'Planned platform') : 'Platform not yet known'}</small></div>
        </div>
        ${top.leave ? `<p class="h-leave">${top.leave}</p>` : ''}
        <div class="board h-board">${rows.map((r) => trainRow(r, walk).html).join('')}</div>
        <p class="b-foot">${d.source === 'national-rail' ? 'Live times and platforms from National Rail.' : 'Timetabled platforms until the station announces them.'} Tap a train to see it on the map.</p>`;
      }
      html += `<div class="h-more"><button class="h-link" type="button" data-board="${c.from.c}|${c.to.c}">Full departures board</button><button class="h-link" type="button" data-board="${c.from.c}|">All trains from ${esc(ctx.short(c.from.n))}</button></div>`;
      html += ctx.busNearby ? ctx.busNearby(c.from, walk) : '';
      html += '</section>';
    }
    // Other saved routes, one line each
    const others = favs.slice(1);
    if (others.length) {
      html += '<section class="h-card"><h3 class="h-head">Your other routes</h3><ul class="h-routes">';
      for (const f of others) {
        const a = ctx.byCrs(f.f);
        const b = ctx.byCrs(f.t);
        if (!a || !b) continue;
        const d = boards.get(`${f.f}|${f.t}`);
        const r = d && (d.rows.find((x) => x.best) || d.rows[0]);
        const [exp, cls] = r ? ctx.expText(r) : ['', ''];
        html += `<li><button type="button" data-board="${f.f}|${f.t}"><span class="h-r">${esc(ctx.short(a.n))} → ${esc(ctx.short(b.n))}</span>
          <span class="h-n">${r ? `${esc(r.std)} <span class="b-exp ${cls}">${exp}</span>${r.plat ? ` · plat ${esc(r.plat)}` : ''}` : d ? 'No direct trains soon' : '…'}</span></button></li>`;
      }
      html += '</ul></section>';
    }
    body.innerHTML = html + extras.map((f) => f()).join('');
  }

  async function refresh() {
    if (el.hidden) return;
    const c = commute();
    const jobs = [];
    if (c) jobs.push(fetchBoard(c.from.c, c.to.c));
    for (const f of ctx.favs().slice(1, 6)) jobs.push(fetchBoard(f.f, f.t));
    render();
    await Promise.all(jobs);
    render();
  }

  body.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.classList.contains('h-swap')) {
      const c = commute();
      const favs = ctx.favs();
      const rev = c && favs[0] && c.from.c !== favs[0].f;
      flipped = { rev: !rev, until: Date.now() + 4 * 3600000 };
      ctx.store.set('commuteFlip', flipped);
      refresh();
      return;
    }
    if (b.dataset.go) return ctx.setTab(b.dataset.go);
    if (b.dataset.board) {
      const [from, to] = b.dataset.board.split('|');
      return ctx.openBoard(from, to || null);
    }
    if (b.dataset.id && !ctx.showTrain(b.dataset.id)) {
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
