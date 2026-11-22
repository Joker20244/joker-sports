/* Joker Sports — app logic
 * Renders data/matches.json (built daily by GitHub Actions), caches it for
 * offline viewing, and merges live status/scores straight from ESPN's public
 * JSON when the browser is online (CORS-enabled).
 */
(function () {
  'use strict';

  var DATA_URL = 'matches.json';
  var CACHE_KEY = 'joker-sports-data-v1';
  var TZ = 'Africa/Cairo';
  var DOW_AR = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];

  var state = {
    data: null,
    league: 'all',
    search: '',
    favOnly: false,
    liveStatus: {} // espn event id -> {score home/away, detail, state}
  };

  var matchesEl = document.getElementById('matches');
  var chipsEl = document.getElementById('league-chips');
  var noticeEl = document.getElementById('notice-bar');
  var freshnessEl = document.getElementById('freshness');

  function fmtTime(iso) {
    var d = new Date(iso);
    return d.toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit', timeZone: TZ, hour12: true });
  }
  function dayKey(iso) {
    var d = new Date(iso);
    return d.toLocaleDateString('en-CA', { timeZone: TZ }); // YYYY-MM-DD in Cairo
  }
  function dayTitle(key) {
    var d = new Date(key + 'T12:00:00Z');
    var dow = new Intl.DateTimeFormat('ar-EG', { weekday: 'long', timeZone: TZ }).format(d);
    var date = new Intl.DateTimeFormat('ar-EG', { day: 'numeric', month: 'long', timeZone: TZ }).format(d);
    return { dow: dow, date: date };
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ---------- data loading ---------- */
  function loadData() {
    return fetch(DATA_URL, { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (json) {
      try { localStorage.setItem(CACHE_KEY, JSON.stringify(json)); } catch (e) {}
      return { json: json, fromCache: false };
    }).catch(function (err) {
      var cached = null;
      try { cached = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null'); } catch (e) {}
      if (cached) return { json: cached, fromCache: true };
      throw err;
    });
  }

  /* ---------- live merge from ESPN (best-effort) ---------- */
  function todayUtcStamp() {
    var d = new Date();
    return d.getUTCFullYear() + String(d.getUTCMonth() + 1).padStart(2, '0') + String(d.getUTCDate()).padStart(2, '0');
  }
  function refreshLive() {
    if (!state.data) return;
    var slugs = {};
    state.data.matches.forEach(function (m) {
      if (m.id.indexOf('espn-') === 0) slugs[m.league.slug] = true;
    });
    var stamp = todayUtcStamp();
    Object.keys(slugs).forEach(function (slug) {
      fetch('https://site.api.espn.com/apis/site/v2/sports/soccer/' + slug + '/scoreboard?dates=' + stamp + '&limit=200')
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) {
          if (!d || !d.events) return;
          d.events.forEach(function (ev) {
            var comp = (ev.competitions || [{}])[0];
            var comps = comp.competitors || [];
            var home = comps.filter(function (c) { return c.homeAway === 'home'; })[0];
            var away = comps.filter(function (c) { return c.homeAway === 'away'; })[0];
            var st = (comp.status || {}).type || {};
            state.liveStatus['espn-' + ev.id] = {
              state: st.state,
              detail: st.shortDetail || st.description,
              completed: !!st.completed,
              homeScore: home && home.score, awayScore: away && away.score,
              homeWinner: home && home.winner, awayWinner: away && away.winner
            };
          });
          render();
        })
        .catch(function () { /* offline or blocked: static data stays */ });
    });
  }

  /* ---------- rendering ---------- */
  function passesFilters(m) {
    if (state.league !== 'all' && m.league.slug !== state.league) return false;
    if (state.favOnly && !(m.home.favorite || m.away.favorite)) return false;
    if (state.search) {
      var hay = [m.home.name, m.home.nameAr, m.away.name, m.away.nameAr, m.league.nameAr, m.league.name]
        .filter(Boolean).join(' ').toLowerCase();
      if (hay.indexOf(state.search.toLowerCase()) === -1) return false;
    }
    return true;
  }

  function statusOf(m) {
    var live = state.liveStatus[m.id];
    if (live) return live;
    return m.status || {};
  }

  function renderChips() {
    var leagues = [{ slug: 'all', nameAr: 'الكل' }].concat(state.data.leagues);
    chipsEl.innerHTML = '';
    leagues.forEach(function (lg) {
      var has = lg.slug === 'all' || state.data.matches.some(function (m) { return m.league.slug === lg.slug; });
      if (!has) return;
      var b = document.createElement('button');
      b.className = 'chip' + (state.league === lg.slug ? ' active' : '');
      b.textContent = lg.nameAr || lg.name;
      b.onclick = function () { state.league = lg.slug; render(); renderChips(); };
      chipsEl.appendChild(b);
    });
  }

  function channelHtml(m) {
    if (!m.broadcasts || !m.broadcasts.length) {
      return '<span class="info-value missing">لم تُعلن بعد</span>';
    }
    var allUs = m.broadcasts.every(function (b) { return !b.region || b.region === 'us'; });
    var tags = m.broadcasts.map(function (b) {
      var label = b.media + (b.type === 'STREAMING' ? ' (بث رقمي)' : '');
      var reg = (!b.region || b.region === 'us') ? ' «أمريكا»' : ' (' + esc(b.region) + ')';
      return '<span class="channel-tag">' + esc(label) + reg + '</span>';
    }).join(' ');
    // Regional honesty: free sources only publish the US market. Say so right
    // at the field - never let US names read as the Egyptian viewer's answer.
    var note = allUs
      ? '<div class="channel-note">قنوات السوق الأمريكي فقط — الناقل في مصر والمنطقة العربية غير متاح من المصدر المجاني.</div>'
      : (m.partialData && m.broadcastNote ? '<div class="channel-note">' + esc(m.broadcastNote) + '</div>' : '');
    return '<span class="info-value">' + tags + '</span>' + note;
  }

  function lineupHtml(m) {
    if (!m.lineups) return '';
    var sides = ['home', 'away'].map(function (side) {
      var players = (m.lineups[side] || []);
      if (!players.length) return '';
      var starters = players.filter(function (p) { return p.starter; });
      var subs = players.filter(function (p) { return !p.starter; });
      var team = side === 'home' ? m.home : m.away;
      var li = starters.map(function (p) {
        return '<li>' + esc(p.name) + (p.position ? ' <span class="sub">(' + esc(p.position) + ')</span>' : '') + '</li>';
      }).join('');
      var subTxt = subs.length ? '<div class="sub">بدلاء: ' + esc(subs.map(function (p) { return p.name; }).join('، ')) + '</div>' : '';
      return '<div><h4>' + esc(team.nameAr || team.name) + '</h4><ol>' + li + '</ol>' + subTxt + '</div>';
    }).join('');
    return sides;
  }

  function matchCard(m) {
    var tpl = document.getElementById('match-card-tpl').content.cloneNode(true);
    var card = tpl.querySelector('.match-card');
    if (m.home.favorite || m.away.favorite) card.classList.add('favorite');
    if (m.partialData) card.classList.add('partial');

    tpl.querySelector('.league-name').textContent = m.league.nameAr || m.league.name;

    var DETAIL_AR = { 'FT': 'انتهت', 'HT': 'بين الشوطين', 'AET': 'انتهت بالوقت الإضافي', 'FT-PENS': 'بركلات الترجيح', 'PEN': 'بركلات الترجيح' };
    function detailAr(d) { return (d && DETAIL_AR[d]) || d || ''; }
    var st = statusOf(m);
    var pill = tpl.querySelector('.status-pill');
    if (st.state === 'in') { pill.classList.add('in'); pill.textContent = 'مباشر' + (detailAr(st.detail) ? ' • ' + detailAr(st.detail) : ''); }
    else if (st.state === 'post' || st.completed) { pill.classList.add('post'); pill.textContent = detailAr(st.detail) || 'انتهت'; }
    else { pill.classList.add('pre'); pill.textContent = 'قادمة'; }

    ['home', 'away'].forEach(function (side) {
      var t = m[side];
      var el = tpl.querySelector('.team.' + side);
      var img = el.querySelector('.team-logo');
      if (t.logo) { img.src = t.logo; img.alt = t.name; } else { img.remove(); }
      var nm = el.querySelector('.team-name');
      nm.innerHTML = esc(t.nameAr || t.name) + (t.nameAr ? '<span class="latin">' + esc(t.name) + '</span>' : '');
    });

    var scoreEl = tpl.querySelector('.score');
    var hs = st.homeScore != null ? st.homeScore : m.home.score;
    var as = st.awayScore != null ? st.awayScore : m.away.score;
    if ((st.state && st.state !== 'pre') || st.completed) scoreEl.textContent = (hs != null ? hs : '-') + ' : ' + (as != null ? as : '-');

    var kick = tpl.querySelector('.kickoff');
    if (!st.completed && (!st.state || st.state === 'pre')) {
      kick.innerHTML = esc(fmtTime(m.kickoffUtc)) + '<span class="dow">' + esc(dayTitle(dayKey(m.kickoffUtc)).dow) + '</span>';
    } else {
      kick.innerHTML = '<span class="dow">' + esc(fmtTime(m.kickoffUtc)) + '</span>';
    }

    tpl.querySelector('.channels .info-value').outerHTML = channelHtml(m);

    var commEl = tpl.querySelector('.commentator .info-value');
    if (m.commentator) commEl.textContent = m.commentator;
    else { commEl.textContent = 'غير معلن من المصدر'; commEl.classList.add('missing'); }

    var qEl = tpl.querySelector('.quality .info-value');
    if (m.quality) qEl.textContent = m.quality;
    else { qEl.textContent = 'لم يحددها المصدر'; qEl.classList.add('missing'); }

    var vEl = tpl.querySelector('.venue .info-value');
    if (m.venue) vEl.textContent = m.venue;
    else { vEl.textContent = 'غير متاح'; vEl.classList.add('missing'); }

    var det = tpl.querySelector('.lineups');
    var lh = lineupHtml(m);
    if (lh) {
      det.hidden = false;
      det.querySelector('.lineups-body').innerHTML = lh;
    }

    tpl.querySelector('.source-line').textContent =
      'المصدر: ' + (m.source && m.source.name) + ' • آخر تحديث للبيانات: ' +
      new Date(state.data.generatedAtUtc).toLocaleString('ar-EG', { timeZone: TZ });

    return tpl;
  }

  function render() {
    var list = state.data.matches.filter(passesFilters);
    matchesEl.innerHTML = '';
    if (!list.length) {
      matchesEl.innerHTML = '<div class="empty"><p>لا توجد مباريات مطابقة لهذا الاختيار.</p></div>';
      return;
    }
    var groups = {};
    var order = [];
    list.forEach(function (m) {
      var k = dayKey(m.kickoffUtc);
      if (!groups[k]) { groups[k] = []; order.push(k); }
      groups[k].push(m);
    });
    order.sort();
    var todayK = dayKey(new Date().toISOString());
    order.forEach(function (k) {
      var g = document.createElement('section');
      g.className = 'day-group';
      var t = dayTitle(k);
      var todayTag = (k === todayK) ? ' • اليوم' : '';
      g.innerHTML = '<h2 class="day-title">' + esc(t.dow + todayTag) + ' <span class="date-sub">' + esc(t.date) + '</span></h2>';
      var cards = document.createElement('div');
      cards.className = 'cards';
      groups[k].forEach(function (m) { cards.appendChild(matchCard(m)); });
      g.appendChild(cards);
      matchesEl.appendChild(g);
    });
  }

  function updateFreshness(fromCache) {
    var gen = new Date(state.data.generatedAtUtc);
    var ageH = (Date.now() - gen.getTime()) / 36e5;
    var txt = 'آخر تحديث: ' + gen.toLocaleString('ar-EG', { timeZone: TZ, dateStyle: 'medium', timeStyle: 'short' });
    freshnessEl.textContent = txt;
    if (ageH > 26 || fromCache) {
      freshnessEl.classList.add('stale');
      noticeEl.hidden = false;
      noticeEl.textContent = fromCache
        ? 'أنت تشاهد نسخة محفوظة من الجدول (لا يوجد اتصال حاليًا). قد تكون المواعيد تغيّرت.'
        : 'مر وقت على آخر تحديث للجدول؛ المواعيد قد تتغير، وسيُحدَّث تلقائيًا مع دورة التحديث اليومية.';
    } else {
      noticeEl.hidden = true;
      freshnessEl.classList.remove('stale');
    }
  }

  function showError() {
    matchesEl.innerHTML = '<div class="error-box"><p>تعذّر تحميل جدول المباريات ولا توجد نسخة محفوظة على هذا الجهاز.</p>' +
      '<button type="button">حاول مرة أخرى</button></div>';
    matchesEl.querySelector('button').onclick = function () { location.reload(); };
  }

  /* ---------- boot ---------- */
  document.getElementById('team-search').addEventListener('input', function (e) {
    state.search = e.target.value.trim(); render();
  });
  document.getElementById('fav-only').addEventListener('change', function (e) {
    state.favOnly = e.target.checked; render();
  });

  loadData().then(function (res) {
    state.data = res.json;
    updateFreshness(res.fromCache);
    renderChips();
    render();
    document.getElementById('footer-sources').textContent =
      'عدد المباريات المعروضة هذا الأسبوع: ' + state.data.counts.matches +
      ' • نافذة الجدول: ' + state.data.windowDays + ' أيام.';
    refreshLive();
    setInterval(refreshLive, 60000);
  }).catch(showError);
})();
