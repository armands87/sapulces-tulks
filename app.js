/* Sapulces tulks v4: live EN -> LV captions with reading-paced reveal. Plain JS, no build.
 *
 * Pipeline: Chrome speech recognition (interim words) -> chunker commits short fragments
 * -> each fragment translated at once (parallel, streamed, hedged) -> words go into a
 * queue -> revealer shows them one by one at a readable pace, in spoken order.
 * Nothing is ever removed from the screen while the user may still be reading.
 */
(function () {
  'use strict';
  var C = window.TCore;
  var $ = function (id) { return document.getElementById(id); };

  /* ---------- Settings (localStorage only) ---------- */
  var SETTINGS_VERSION = 6;
  var DEFAULTS = {
    v: SETTINGS_VERSION, apiKey: '', model: 'gpt-4.1-mini', engine: 'openai',
    showEn: false, theme: 'dark', size: 40, lines: 7, capLines: 7,
    mode: 'captions', chunk: 'short', reveal: 'normal',
    glossary: '', correct: true, corrModel: 'gpt-4.1-mini'
  };
  var S = load();
  function load() {
    var s = {};
    try { s = JSON.parse(localStorage.getItem('tulks.settings') || '{}'); } catch (e) {}
    // one-time migrations, oldest first
    if (!s.v || s.v < 3) { delete s.mode; if (s.size && s.size > 48) delete s.size; }
    if (!s.v || s.v < 4) { delete s.interim; delete s.capLines; }
    if (!s.theme && 'light' in s) s.theme = s.light ? 'light' : 'dark';
    delete s.light;
    var out = {};
    for (var k in DEFAULTS) out[k] = (k in s) ? s[k] : DEFAULTS[k];
    out.v = SETTINGS_VERSION;
    return out;
  }
  function save() {
    try { localStorage.setItem('tulks.settings', JSON.stringify(S)); } catch (e) {}
  }
  function preset() {
    if (window.__tulksLegacy && S.chunk === "short") return C.CHUNK_PRESETS.v6short; // test switch
    return C.CHUNK_PRESETS[S.chunk] || C.CHUNK_PRESETS.short;
  }

  /* ---------- Diagnostics ---------- */
  var diag = [];
  function log(msg) {
    diag.push(new Date().toTimeString().slice(0, 8) + ' ' + msg);
    if (diag.length > 100) diag.shift();
  }
  var lat = []; // per chunk: {wait, api, shown}
  function latencySummary(n) {
    var a = lat.slice(-(n || 30)).filter(function (x) { return x.shown != null; });
    if (!a.length) return null;
    var med = function (k) { return C.median(a.map(function (x) { return x[k]; })); };
    return { n: a.length, shown: med('shown'), wait: med('wait'), api: med('api'), net: med('net') };
  }

  /* ---------- Elements ---------- */
  var feed = $('feed'), cap = $('cap'), capText = $('capText'), caret = $('caret'), liveEn = $('liveEn');
  var statusEl = $('status'), lagEl = $('lag'), dlg = $('settings');
  var errorBar = $('errorBar'), errorText = $('errorText'), backBtn = $('backToLive');
  var MODES = ['captions', 'focus', 'history'];
  var prefersLight = window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;

  function isLight() {
    return S.theme === 'light' || (S.theme === 'auto' && !!(prefersLight && prefersLight.matches));
  }

  function applyView() {
    var root = document.documentElement.style;
    root.setProperty('--size', S.size + 'px');
    root.setProperty('--caplines', S.capLines);
    var b = document.body.classList;
    var light = isLight();
    b.toggle('light', light);
    b.toggle('show-en', !!S.showEn);
    MODES.forEach(function (m) { b.toggle('mode-' + m, S.mode === m); });
    document.querySelector('meta[name=theme-color]').content = light ? '#ffffff' : '#000000';
    $('keyHint').hidden = !(S.engine === 'openai' && !hasKey());
    if (S.mode !== 'captions') unfreeze(false);
    layout(true);
  }
  if (prefersLight && prefersLight.addEventListener) {
    prefersLight.addEventListener('change', function () { if (S.theme === 'auto') applyView(); });
  }

  /* ---------- Errors and status ---------- */
  var lastError = null;
  function showError(msg, fatal) {
    lastError = { msg: msg, fatal: !!fatal, at: Date.now() };
    errorText.textContent = msg;
    errorBar.hidden = false;
    errorBar.classList.toggle('fatal', !!fatal);
    log('ERR ' + msg);
    updateStatus();
  }
  function clearError(onlyNonFatal) {
    if (!lastError || (onlyNonFatal && lastError.fatal)) return;
    lastError = null;
    errorBar.hidden = true;
    updateStatus();
  }
  $('errorClose').onclick = function () { lastError = null; errorBar.hidden = true; updateStatus(); };

  /* ---------- Screen model ----------
   * seg   = one utterance. Its DOM is created only when its first word is revealed,
   *         so pauses never move anything on screen.
   * chunk = a translated fragment: data (lv text, done) + revealed word count. */
  var segs = [];        // all segments (data)
  var domSegs = [];     // segments that are on screen, in order
  var chunks = [];      // all chunks in spoken order
  var revealIdx = 0;    // index of the chunk being revealed
  var revealTimer = null;
  var lastRevealed = '';
  var liveChunk = null;
  var lastSegEndAt = 0;

  function newSegData() {
    var now = Date.now();
    if (!store.startedAt) store.startedAt = now;
    var seg = { el: null, lvEl: null, enEl: null, en: '', chunks: [],
      breakBefore: now - lastSegEndAt > 2500,
      store: store, rec: { t: now - store.startedAt, en: '', lv: '' } };
    store.records.push(seg.rec);
    segs.push(seg);
    return seg;
  }

  /* ---------- Transcript store (v5) ----------
   * Independent of the screen: every speech segment of the whole conversation,
   * persisted to localStorage so a reload or crash does not lose it. */
  var STORE_KEY = 'tulks.session';
  var store = { startedAt: 0, records: [] };
  var dirty = false, persistTimer = null;

  function syncRecord(seg) {
    if (!seg || !seg.rec || seg.store !== store) return; // ignore late results of a cleared conversation
    seg.rec.en = seg.en;
    seg.rec.lv = seg.chunks.map(function (c) { return c.lv || (c.failed ? c.en : ''); })
      .filter(Boolean).join(' ');
    dirty = true;
    schedulePersist();
  }
  function schedulePersist() {
    if (persistTimer) return;
    persistTimer = setTimeout(persistNow, 2500);
  }
  function persistNow() {
    clearTimeout(persistTimer); persistTimer = null;
    if (!store.records.length) return;
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ v: 1, startedAt: store.startedAt, dirty: dirty, records: store.records }));
    } catch (e) {
      log('persist failed ' + (e && e.name));
      showError('Telefona atmiņā nepietiek vietas sarunas glabāšanai. Saglabā sarunu tagad.', false);
    }
  }
  function loadStored() {
    try {
      var s = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
      if (s && s.startedAt && s.records && C.transcriptStats(s).count) return s;
    } catch (e) {}
    return null;
  }
  function clearStored() { try { localStorage.removeItem(STORE_KEY); } catch (e) {} }
  window.addEventListener('pagehide', persistNow);
  document.addEventListener('visibilitychange', function () { if (document.hidden) persistNow(); });

  /* Put restored segments back on screen as history (fully shown, no reveal). */
  function renderRestored(records) {
    var prevT = null, prevText = '';
    records.forEach(function (r) {
      if (!(r.lv || r.en)) return;
      var seg = { el: null, lvEl: null, enEl: null, en: r.en || '', chunks: [],
        breakBefore: prevT === null || r.t - prevT > 8000 };
      prevT = r.t;
      ensureSegDom(seg);
      var text = (r.lv || r.en || '').trim();
      if (!prevText || /[.!?]["')]*$/.test(prevText)) text = text.charAt(0).toUpperCase() + text.slice(1);
      prevText = text;
      seg.lvEl.textContent = text;
      if (!r.lv) seg.lvEl.classList.add('failed');
    });
    capText.appendChild(caret);
    lastSegEndAt = 0;
    lastRevealed = '.';
    layout(true);
  }

  function ensureSegDom(seg) {
    if (seg.el) return;
    document.body.classList.add('started');
    if (domSegs.length) {
      if (seg.breakBefore) {
        var br = document.createElement('span'); br.className = 'pbreak';
        capText.appendChild(br);
      } else {
        capText.appendChild(document.createTextNode(' '));
      }
    }
    var el = document.createElement('span');
    el.className = 'seg';
    el.innerHTML = '<span class="lv"></span><span class="en"></span>';
    capText.appendChild(el);
    seg.el = el; seg.lvEl = el.firstChild; seg.enEl = el.lastChild;
    seg.enEl.textContent = seg.en;
    domSegs.push(seg);
    trimDom();
  }

  function ensureChunkDom(c) {
    if (c.el) return;
    var seg = c.seg;
    ensureSegDom(seg);
    var hasPrev = false;
    for (var i = 0; i < seg.chunks.length && seg.chunks[i] !== c; i++) if (seg.chunks[i].el) hasPrev = true;
    if (hasPrev) seg.lvEl.appendChild(document.createTextNode(' '));
    var span = document.createElement('span');
    span.className = 'chunk' + (c.failed ? ' failed' : '');
    seg.lvEl.appendChild(span);
    c.el = span;
  }

  function addChunk(seg, en, seenAvg, endsSentence) {
    var c = { el: null, en: en, lv: '', index: chunks.length, seg: seg, endsSentence: endsSentence,
      seenAvg: seenAvg, commitAt: Date.now(), firstAt: 0, done: false, failed: false, revealed: 0, lat: null };
    chunks.push(c);
    seg.chunks.push(c);
    translateChunk(c, 0);
    return c;
  }

  function wordsOf(c) {
    if (c.failed && !c.lv) return C.availableWords(c.en, true);
    return C.availableWords(c.lv, c.done || c.failed);
  }

  /* Words ready to show without skipping ahead of an unfinished earlier chunk. */
  function backlog() {
    var n = 0;
    for (var i = revealIdx; i < chunks.length; i++) {
      var c = chunks[i];
      n += Math.max(0, wordsOf(c).length - c.revealed);
      if (!c.done && !c.failed) break;
    }
    return n;
  }

  /* Called whenever translated text arrives. Starts the reveal loop if it is idle. */
  /* v7: how fast translated words actually arrive (words/s over the last 8 s). */
  var arrivals = [];
  function noteAvailable(c) {
    var n = wordsOf(c).length;
    if (n > (c.availSeen || 0)) { arrivals.push([Date.now(), n - (c.availSeen || 0)]); c.availSeen = n; }
  }
  function incomingRate() {
    if (window.__tulksLegacy) return 0; // test switch: v6 pacing for before/after measurements
    var now = Date.now();
    while (arrivals.length && now - arrivals[0][0] > 8000) arrivals.shift();
    var sum = 0;
    for (var i = 0; i < arrivals.length; i++) sum += arrivals[i][1];
    if (sum < 3) return 0;
    return sum / (Math.max(2000, now - arrivals[0][0]) / 1000);
  }

  function poke() {
    if (!revealTimer) pump();
    updateLag();
    setAwaiting();
  }

  function pump() {
    revealTimer = null;
    if (!revealNext()) { updateLag(); setAwaiting(); return; }
    var b = backlog();
    if (b === 0 && !hasPendingWork()) { updateLag(); setAwaiting(); return; }
    revealTimer = setTimeout(pump, C.revealDelay(b, S.reveal, lastRevealed, incomingRate()));
    updateLag();
    setAwaiting();
  }

  /* "Still translating" indicator: the cursor breathes instead of the screen looking frozen. */
  var awaitingTimer = null;
  function setAwaiting() {
    var waiting = running && backlog() === 0 &&
      (hasPendingWork() || (utter && utter.words.length > utter.committed));
    clearTimeout(awaitingTimer);
    if (!waiting) { document.body.classList.remove('awaiting'); return; }
    awaitingTimer = setTimeout(function () { document.body.classList.add('awaiting'); }, 350);
  }

  function hasPendingWork() {
    for (var i = revealIdx; i < chunks.length; i++) if (!chunks[i].done && !chunks[i].failed) return true;
    return false;
  }

  function revealNext() {
    var c = chunks[revealIdx];
    while (c && (c.done || c.failed) && c.revealed >= wordsOf(c).length) { c = chunks[++revealIdx]; }
    if (!c) return false;
    var words = wordsOf(c);
    if (c.revealed >= words.length) return false; // head-of-line chunk still streaming
    var word = words[c.revealed];
    if (c.revealed === 0 && (!lastRevealed || /[.!?]["')]*$/.test(lastRevealed))) {
      word = word.charAt(0).toUpperCase() + word.slice(1);
    }
    ensureChunkDom(c);
    c.el.textContent += (c.revealed ? ' ' : '') + word;
    if (c.revealed === 0) {
      if (c.lat) { c.lat.shown = Date.now() - c.seenAvg; updateStatus(); }
      if (c.failed && !c.lv) c.el.classList.add('failed');
    }
    c.revealed++;
    lastRevealed = word;
    c.seg.lvEl.appendChild(caret);
    if (liveChunk !== c) {
      if (liveChunk && liveChunk.el) liveChunk.el.classList.remove('live');
      liveChunk = c;
      c.el.classList.add('live');
    }
    if (frozen) { newWhileFrozen++; updateBackBtn(); }
    layout(false);
    if (window.__tulks) window.__tulks.revealLog.push(Date.now());
    return true;
  }

  /* Lag indicator: how far the screen is behind live speech. */
  function updateLag() {
    var b = backlog();
    var c = chunks[revealIdx];
    var sec = c && c.revealed < wordsOf(c).length ? (Date.now() - c.seenAvg) / 1000 : 0;
    if (running && (b >= 8 || sec >= 4)) {
      lagEl.hidden = false;
      lagEl.textContent = 'Kavējums ' + Math.round(sec) + ' s · ' + b + ' v.';
    } else {
      lagEl.hidden = true;
    }
  }

  function trimDom() {
    var max = S.mode === 'history' ? S.lines + 40 : 400;
    while (domSegs.length > max) {
      var s = domSegs.shift();
      while (capText.firstChild && capText.firstChild !== s.el) capText.removeChild(capText.firstChild);
      capText.removeChild(s.el);
      s.el = null;
    }
  }

  /* ---------- Scrolling, freeze and back to live ---------- */
  var frozen = false, newWhileFrozen = 0, lastScrollTop = 0, userTouchAt = 0;

  function atBottom() { return cap.scrollHeight - cap.clientHeight - cap.scrollTop < 6; }

  function freeze() {
    if (S.mode !== 'captions' || frozen) return;
    frozen = true; newWhileFrozen = 0;
    document.body.classList.add('frozen');
    updateBackBtn();
    log('freeze');
  }
  function unfreeze(scroll) {
    if (!frozen) return;
    frozen = false;
    document.body.classList.remove('frozen');
    backBtn.hidden = true;
    if (scroll !== false) cap.scrollTo({ top: cap.scrollHeight, behavior: 'smooth' });
    log('back to live');
  }
  function updateBackBtn() {
    backBtn.hidden = false;
    backBtn.textContent = 'Atpakaļ uz tiešraidi' + (newWhileFrozen ? ' · ' + C.plural(newWhileFrozen, 'jauns vārds', 'jauni vārdi') : '');
  }
  backBtn.onclick = function () { unfreeze(true); };

  // v6: a tap shows the controls; only scrolling up freezes the view
  function onUserTouch() { userTouchAt = Date.now(); }
  cap.addEventListener('pointerdown', onUserTouch);
  cap.addEventListener('touchstart', onUserTouch, { passive: true });
  cap.addEventListener('wheel', onUserTouch, { passive: true });
  cap.addEventListener('scroll', function () {
    var t = cap.scrollTop;
    var user = Date.now() - userTouchAt < 2500;
    if (user && t < lastScrollTop - 4) freeze();                       // scrolled up
    else if (user && frozen && t > lastScrollTop && atBottom()) unfreeze(false); // scrolled back down
    lastScrollTop = t;
  });

  function layout(force) {
    if (S.mode === 'captions') {
      domSegs.forEach(function (s) { s.el.style.display = ''; s.el.style.opacity = ''; s.el.classList.remove('current', 'prev'); });
      if (!frozen) {
        var gap = cap.scrollHeight - cap.clientHeight - cap.scrollTop;
        if (gap > 2) cap.scrollTo({ top: cap.scrollHeight, behavior: force || window.__noSmooth ? 'auto' : 'smooth' });
      }
      return;
    }
    var styles = C.lineStyles(S.mode, domSegs.length, S.lines);
    for (var i = 0; i < domSegs.length; i++) {
      var el = domSegs[i].el, st = styles[i];
      el.style.display = st.show ? '' : 'none';
      el.style.opacity = S.mode === 'history' && st.show ? String(st.opacity) : '';
      el.classList.toggle('current', st.role === 'current');
      el.classList.toggle('prev', st.role === 'prev');
    }
    feed.scrollTop = feed.scrollHeight;
  }

  /* ---------- Translation ---------- */
  var chromeTranslator = null;
  var inflight = 0, lastApiAt = 0;
  var HEDGE_MS = 2500;

  function hasKey() { return S.apiKey && S.apiKey.trim().length > 20; }

  function makeErr(status, body, cancelled, model) {
    var info = C.classifyError(status, body, model || S.model);
    var e = new Error(info.msg);
    e.status = status; e.info = info; e.cancelled = !!cancelled;
    return e;
  }

  /* Streamed chat completion with total + stall timeouts and external cancel. Always settles. */
  function openaiStream(body, onDelta, opts) {
    if (!hasKey()) return Promise.reject(makeErr(401, '{}'));
    opts = opts || {};
    var ctrl = new AbortController(), reason = '';
    function abort(why) { if (!reason) { reason = why; try { ctrl.abort(); } catch (e) {} } }
    if (opts.signal) {
      if (opts.signal.aborted) abort('cancel');
      else opts.signal.addEventListener('abort', function () { abort('cancel'); });
    }
    var total = setTimeout(function () { abort('timeout'); }, opts.timeoutMs || 10000);
    var stall = null;
    function armStall() { clearTimeout(stall); stall = setTimeout(function () { abort('stall'); }, opts.stallMs || 5000); }
    function done() { clearTimeout(total); clearTimeout(stall); }
    armStall();
    lastApiAt = Date.now();
    inflight++; updateStatus();
    return fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + S.apiKey.trim() },
      body: JSON.stringify(body),
      signal: ctrl.signal
    }).then(function (res) {
      if (!res.ok) return res.text().catch(function () { return ''; }).then(function (t) { throw makeErr(res.status, t, false, body.model); });
      armStall();
      var reader = res.body.getReader(), dec = new TextDecoder(), parser = new C.SSEParser(), full = '';
      function pump() {
        return reader.read().then(function (r) {
          if (r.done) return full;
          armStall();
          var deltas = parser.push(dec.decode(r.value, { stream: true }));
          for (var i = 0; i < deltas.length; i++) { full += deltas[i]; onDelta(full); }
          if (parser.done) { try { reader.cancel(); } catch (e) {} return full; }
          return pump();
        });
      }
      return pump();
    }).then(function (full) {
      done(); inflight--; updateStatus();
      return full.trim();
    }, function (e) {
      done(); inflight--; updateStatus();
      if (e && e.info) throw e;
      throw makeErr(0, '', reason === 'cancel');
    });
  }

  function chromeTranslate(text) {
    var get = chromeTranslator ? Promise.resolve(chromeTranslator) :
      self.Translator.create({ sourceLanguage: 'en', targetLanguage: 'lv' }).then(function (t) { chromeTranslator = t; return t; });
    inflight++; updateStatus();
    return get.then(function (t) { return t.translate(text); }).then(function (r) {
      inflight--; updateStatus(); return r;
    }, function (e) {
      inflight--; updateStatus();
      var err = new Error('Chrome tulkotāja kļūda: ' + (e && e.message));
      err.info = { msg: err.message, retry: false, fatal: false };
      throw err;
    });
  }

  /* Keep the TLS/HTTP2 connection to OpenAI warm: a cold connection adds 200-600 ms. */
  function warm() {
    if (S.engine !== 'openai' || !hasKey()) return;
    lastApiAt = Date.now();
    fetch('https://api.openai.com/v1/models/' + encodeURIComponent(S.model), {
      headers: { 'Authorization': 'Bearer ' + S.apiKey.trim() }
    }).then(function (r) {
      log('warm ' + r.status);
      if (r.status === 401) showError(C.classifyError(401, '', S.model).msg, true);
      if (r.status === 404) showError(C.classifyError(404, '', S.model).msg, true);
    }).catch(function () { log('warm failed'); });
  }

  function contextBefore(c) {
    var en = [], lv = [];
    for (var i = Math.max(0, c.index - 24); i < c.index; i++) { // cut to ~500 chars in core
      en.push(chunks[i].en);
      if (chunks[i].lv) lv.push(chunks[i].lv);
    }
    return { en: en.join(' '), lv: lv.join(' ') };
  }

  /*
   * Translate one chunk. If no first token within HEDGE_MS, a second identical request
   * is started; whichever streams first wins and the other is cancelled. Failures retry
   * up to 2 times; if all fail, the English fragment is shown instead (dimmed).
   */
  function translateChunk(c, attempt) {
    var ctx = contextBefore(c);
    var body = C.buildChunkBody(S.model || DEFAULTS.model, c.en, ctx.en, ctx.lv, c.endsSentence, S.glossary);
    var owner = null, pending = 0, finished = false, lastErr = null, ctrls = {}, hedge = null;

    function onDelta(tag, partial) {
      if (finished) return;
      if (owner === null) {
        owner = tag;
        for (var k in ctrls) if (k !== tag) { try { ctrls[k].abort(); } catch (e) {} }
        if (!c.firstAt) {
          c.firstAt = Date.now();
          c.lat = { wait: c.commitAt - c.seenAvg, api: c.firstAt - c.commitAt, net: c.firstAt - c.seenAvg, shown: null };
          lat.push(c.lat); if (lat.length > 300) lat.shift();
        }
      }
      if (owner !== tag) return;
      c.lv = partial;
      noteAvailable(c);
      poke();
    }
    function launch(tag) {
      var ctrl = new AbortController();
      ctrls[tag] = ctrl; pending++;
      var p = S.engine === 'chrome'
        ? chromeTranslate(c.en).then(function (t) { onDelta(tag, t); return t; })
        : openaiStream(body, function (t) { onDelta(tag, t); }, { signal: ctrl.signal, timeoutMs: 10000, stallMs: 4000 });
      p.then(function (full) {
        pending--;
        if (finished) return;
        if (owner === null) owner = tag;
        if (owner === tag) finish(full);
      }, function (e) {
        pending--;
        if (finished || e.cancelled) return;
        if (owner === tag || pending === 0) fail(e);
        else lastErr = e;
      });
    }
    function finish(full) {
      finished = true; clearTimeout(hedge);
      c.lv = full || c.lv;
      c.done = true;
      if (!c.lv) c.failed = true;
      c.draftLv = c.lv;
      c.doneAt = Date.now();
      noteAvailable(c);
      clearError(false);
      syncRecord(c.seg);
      poke();
      scheduleCorrection();
    }
    function fail(e) {
      finished = true; clearTimeout(hedge);
      var info = e.info || (lastErr && lastErr.info) || { msg: String(e.message || e), retry: false, fatal: false };
      log('chunk #' + c.index + ' fail ' + attempt + ' status=' + e.status);
      if (info.retry && attempt < 2) {
        showError(info.msg, false);
        setTimeout(function () { translateChunk(c, attempt + 1); }, C.retryDelay(attempt) / 2);
        return;
      }
      showError(info.msg, info.fatal);
      c.failed = true; // the revealer shows the English fragment instead
      syncRecord(c.seg);
      poke();
    }

    launch('a');
    if (S.engine === 'openai') {
      hedge = setTimeout(function () {
        if (!finished && owner === null) { log('hedge #' + c.index); launch('b'); }
      }, HEDGE_MS);
    }
  }

  /* ---------- Context correction (v7) ----------
   * Groups of ~8+ English words are re-checked once the following words are known (or
   * 2.5 s have passed). The screen changes only if the Latvian differs meaningfully, the
   * line is fully shown and still visible, and the user is not scrolled back reading. */
  var corrIdx = 0, corrBusy = 0, corrTimer = null;
  var corrStats = { sent: 0, changed: 0, kept: 0, failed: 0, offscreen: 0, last: [] };
  var CORR_MIN_WORDS = 8, CORR_WAIT_MS = 2500;

  function wc(s) { return (s || '').split(/\s+/).filter(Boolean).length; }

  function scheduleCorrection(ms) {
    clearTimeout(corrTimer);
    corrTimer = setTimeout(runCorrection, ms == null ? 60 : ms);
  }

  function runCorrection() {
    if (!S.correct || S.engine !== 'openai' || !hasKey()) return;
    if (corrBusy >= 2) { scheduleCorrection(500); return; }
    while (corrIdx < chunks.length && (chunks[corrIdx].failed || chunks[corrIdx].seg.store !== store)) corrIdx++;
    if (corrIdx >= chunks.length) return;
    var seg = chunks[corrIdx].seg, group = [], words = 0;
    for (var i = corrIdx; i < chunks.length; i++) {
      var c = chunks[i];
      if (c.seg !== seg || c.failed) break;
      if (!c.done) return; // wait: finish() schedules us again
      group.push(c); words += wc(c.en);
      if (words >= CORR_MIN_WORDS) break;
    }
    if (!group.length) { corrIdx++; scheduleCorrection(); return; }
    var last = group[group.length - 1];
    var segClosed = seg.endedAt && seg.chunks[seg.chunks.length - 1] === last;
    if (words < CORR_MIN_WORDS && !segClosed) return; // more words of this sentence will come
    var after = [], afterWords = 0;
    for (var j = last.index + 1; j < chunks.length && afterWords < 25; j++) { after.push(chunks[j].en); afterWords += wc(chunks[j].en); }
    var lastDone = Math.max.apply(null, group.map(function (g) { return g.doneAt || 0; }));
    if (afterWords < 3 && Date.now() - lastDone < CORR_WAIT_MS) { scheduleCorrection(700); return; }
    corrIdx = last.index + 1;
    sendCorrection(group, after.join(' '));
    scheduleCorrection();
  }

  /* Non-streamed JSON request (corrections are not time critical). */
  function openaiJson(body, timeoutMs) {
    var ctrl = new AbortController();
    var t = setTimeout(function () { try { ctrl.abort(); } catch (e) {} }, timeoutMs || 12000);
    lastApiAt = Date.now();
    return fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + S.apiKey.trim() },
      body: JSON.stringify(body), signal: ctrl.signal
    }).then(function (res) {
      clearTimeout(t);
      if (!res.ok) return res.text().then(function (x) { throw makeErr(res.status, x, false, body.model); });
      return res.json();
    }).then(function (j) {
      return j.choices && j.choices[0] && j.choices[0].message ? j.choices[0].message.content || '' : '';
    }, function (e) { clearTimeout(t); throw e; });
  }

  function sendCorrection(group, afterEn) {
    var first = group[0], seg = first.seg;
    var before = { en: [], lv: [] };
    for (var i = Math.max(0, first.index - 24); i < first.index; i++) {
      before.en.push(chunks[i].en); if (chunks[i].lv) before.lv.push(chunks[i].lv);
    }
    var targetLv = group.map(function (c) { return c.lv; }).join(' ').trim();
    var o = {
      glossary: S.glossary, beforeEn: before.en.join(' '), beforeLv: before.lv.join(' '),
      targetEn: group.map(function (c) { return c.en; }).join(' '), targetLv: targetLv,
      afterEn: afterEn, alts: seg.endedAt && seg.alts ? seg.alts : null
    };
    corrBusy++; corrStats.sent++;
    openaiJson(C.buildCorrectionBody(S.corrModel || DEFAULTS.corrModel, o)).then(function (text) {
      var lv = C.parseCorrection(text);
      if (!lv || !C.meaningfulChange(targetLv, lv)) { corrStats.kept++; return; }
      applyCorrection(group, lv, targetLv, 0);
    }).catch(function (e) {
      corrStats.failed++;
      log('correction failed ' + (e && e.status));
    }).then(function () { corrBusy--; });
  }

  function onScreen(el) {
    if (!el || !el.isConnected) return false;
    if (S.mode !== 'captions') return el.offsetParent !== null;
    var r = el.getBoundingClientRect(), cr = cap.getBoundingClientRect();
    return r.bottom > cr.top + 4 && r.top < cr.bottom - 4;
  }

  function applyCorrection(group, lv, oldLv, tries) {
    var seg = group[0].seg;
    if (seg.store !== store) return; // conversation was cleared meanwhile
    // never change words that are still being revealed: wait for the revealer (max ~5 s)
    var revealing = group.some(function (c) { return c.revealed < wordsOf(c).length; });
    if (revealing && tries < 10) { setTimeout(function () { applyCorrection(group, lv, oldLv, tries + 1); }, 500); return; }
    var firstEl = group[0].el;
    if (firstEl && /^[A-ZĀČĒĢĪĶĻŅŠŪŽ]/.test(firstEl.textContent)) lv = lv.charAt(0).toUpperCase() + lv.slice(1);
    // data first: the transcript always keeps the corrected text (and the first draft)
    if (seg.rec && seg.rec.draft == null) seg.rec.draft = seg.chunks.map(function (c) { return c.lv; }).join(' ').trim();
    group.forEach(function (c, k) {
      c.lv = k === 0 ? lv : '';
      c.corrected = true;
      c.revealed = wordsOf(c).length;
    });
    syncRecord(seg);
    corrStats.changed++;
    corrStats.last.push(oldLv + '  →  ' + lv);
    if (corrStats.last.length > 8) corrStats.last.shift();
    log('fix #' + group[0].index + ': ' + oldLv + ' -> ' + lv);
    // screen: only if visible and the user is following live; otherwise leave the text still
    var els = group.map(function (c) { return c.el; }).filter(Boolean);
    if (!els.length || frozen || !els.some(onScreen)) { corrStats.offscreen++; return; }
    els.forEach(function (el) { el.classList.add('fixing'); });
    setTimeout(function () {
      els.forEach(function (el, k) {
        el.textContent = k === 0 ? lv : '';
        el.classList.remove('fixing');
      });
      els[0].classList.add('fixed');
      layout(false);
    }, 180);
    if (window.__tulks) window.__tulks.fixLog.push({ at: Date.now(), index: group[0].index, from: oldLv, to: lv });
  }

  /* ---------- Chunker: turns recognizer words into fragments ---------- */
  var utter = null;
  var pauseTimer = null;

  function ensureUtter() {
    if (!utter) utter = { seg: newSegData(), words: [], committed: 0, seenAt: [], lastChangeAt: Date.now(), text: '' };
    return utter;
  }

  function setWords(text) {
    var u = ensureUtter(), now = Date.now();
    var words = text.trim().split(/\s+/).filter(Boolean);
    for (var i = 0; i < words.length; i++) if (u.seenAt[i] == null) u.seenAt[i] = now;
    if (text !== u.text) { u.text = text; u.lastChangeAt = now; }
    u.words = words;
    u.seg.en = words.join(' ');
    if (u.seg.enEl) u.seg.enEl.textContent = u.seg.en;
    syncRecord(u.seg);
    liveEn.textContent = C.tail(u.seg.en, 90);
  }

  function runChunker(event) {
    var u = utter;
    if (!u) return;
    var p = preset();
    for (var guard = 0; guard < 20; guard++) {
      var n = C.planChunk(u.words, u.committed, event, p);
      if (!n) break;
      var from = u.committed, to = from + n;
      var seen = u.seenAt.slice(from, to).filter(function (x) { return x != null; });
      var seenAvg = seen.length ? seen.reduce(function (a, b) { return a + b; }, 0) / seen.length : Date.now();
      u.committed = to;
      addChunk(u.seg, u.words.slice(from, to).join(' '), seenAvg, event === 'final' && to >= u.words.length);
      if (event !== 'interim') break;
    }
  }

  function onInterimText(text) {
    setWords(text);
    runChunker('interim');
    clearTimeout(pauseTimer);
    var p = preset();
    pauseTimer = setTimeout(function () {
      if (utter && Date.now() - utter.lastChangeAt >= p.pauseMs - 20) runChunker('pause');
    }, p.pauseMs);
  }

  function onFinalText(text, alts) {
    setWords(text);
    if (alts && alts.length && utter) utter.seg.alts = alts;
    runChunker('final');
    endUtter();
  }

  function endUtter() {
    clearTimeout(pauseTimer);
    if (utter) {
      runChunker('final');
      if (!utter.seg.chunks.length) { // never shown: drop it from screen model and transcript
        segs.splice(segs.indexOf(utter.seg), 1);
        var ri = store.records.indexOf(utter.seg.rec);
        if (ri >= 0) store.records.splice(ri, 1);
      }
      utter.seg.endedAt = Date.now();
      lastSegEndAt = Date.now();
      scheduleCorrection();
    }
    utter = null;
  }

  /* ---------- Speech recognition (hardened in v2) ---------- */
  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  var rec = null, gen = 0, running = false;
  var active = false, starting = false, startCalledAt = 0;
  var restartTimer = null, restartScheduledAt = 0;
  var fails = 0, sessionStart = 0, lastEventAt = 0, lastFinalRaw = '', gotResult = false;
  var everWorked = false, notAllowedCount = 0;
  var wakeLock = null, watchdog = null;
  var SILENT_LIMIT = 30000;

  function makeRec() {
    var myGen = ++gen;
    var r = new SR();
    r.lang = 'en-US';
    r.continuous = true;
    r.interimResults = true;
    r.maxAlternatives = 3; // v7: alternatives are passed to the correction pass as hints
    function mine() { return myGen === gen; }
    function touch() { if (mine()) lastEventAt = Date.now(); }
    r.onaudiostart = touch;
    r.onsoundstart = function () { touch(); if (mine()) statusEl.classList.add('sound'); };
    r.onsoundend = function () { touch(); if (mine()) statusEl.classList.remove('sound'); };
    r.onspeechstart = touch;
    r.onstart = function () {
      if (!mine()) return;
      active = true; starting = false;
      sessionStart = Date.now(); lastEventAt = Date.now();
      gotResult = false; lastFinalRaw = '';
      log('rec start');
      updateStatus();
    };
    r.onresult = function (e) { if (mine()) onResult(e); };
    r.onerror = function (ev) {
      if (!mine()) return;
      lastEventAt = Date.now();
      log('rec error ' + ev.error);
      if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') {
        notAllowedCount++;
        if (!everWorked || notAllowedCount > 5) {
          stop();
          showError('Chrome neļauj izmantot mikrofonu. Atļauj to adreses joslā (slēdzene) un nospied Sākt.', true);
          return;
        }
      }
      if (ev.error === 'network') showError('Runas atpazīšanai nav interneta, mēģina vēlreiz', false);
      else if (ev.error === 'audio-capture') showError('Mikrofons nav pieejams (vai to izmanto cita lietotne)', false);
      setTimeout(function () {
        if (mine() && running && (active || starting)) { log('no onend after error, kick'); kick(); }
      }, 1500);
    };
    r.onend = function () {
      if (!mine()) return;
      active = false; starting = false;
      statusEl.classList.remove('sound');
      log('rec end');
      endUtter();
      if (!running) { updateStatus(); return; }
      var short = Date.now() - sessionStart < 2000 && !gotResult;
      fails = short ? fails + 1 : 0;
      scheduleRestart(C.restartDelay(fails));
    };
    return r;
  }

  function kick() {
    var old = rec;
    rec = null; gen++;
    active = false; starting = false;
    statusEl.classList.remove('sound');
    if (old) { try { old.abort(); } catch (e) {} }
    endUtter();
    if (running) scheduleRestart(300);
  }

  function scheduleRestart(delay) {
    clearTimeout(restartTimer);
    restartScheduledAt = Date.now();
    restartTimer = setTimeout(startRec, delay);
    updateStatus();
  }

  function startRec() {
    restartTimer = null;
    if (!running || active || starting || document.hidden) { updateStatus(); return; }
    if (!rec) rec = makeRec();
    try {
      starting = true; startCalledAt = Date.now();
      rec.start();
    } catch (e) {
      log('start threw ' + (e && e.name));
      starting = false;
      fails++;
      kick();
      clearTimeout(restartTimer);
      scheduleRestart(C.restartDelay(fails));
    }
    updateStatus();
  }

  function onResult(e) {
    lastEventAt = Date.now();
    gotResult = true; everWorked = true;
    fails = 0; notAllowedCount = 0;
    var interimText = '';
    for (var i = e.resultIndex; i < e.results.length; i++) {
      var r = e.results[i];
      var t = r[0] ? r[0].transcript : '';
      if (r.isFinal) {
        var part = C.newFinalPart(lastFinalRaw, t);
        lastFinalRaw = t.trim();
        var alts = [];
        for (var a = 1; a < r.length; a++) if (r[a] && r[a].transcript) alts.push(r[a].transcript.trim());
        if (part) onFinalText(part, alts);
      } else interimText += t;
    }
    interimText = C.newFinalPart(lastFinalRaw, interimText.trim());
    if (interimText) onInterimText(interimText);
  }

  function updateStatus() {
    var text, kind;
    if (!SR) { text = 'Nav runas atpazīšanas'; kind = 'err'; }
    else if (!running) { text = lastError && lastError.fatal ? 'Apturēts (kļūda)' : (document.body.classList.contains('started') ? 'Apturēts' : 'Gatavs'); kind = lastError && lastError.fatal ? 'err' : 'off'; }
    else if (document.hidden) { text = 'Fonā, apturēts'; kind = 'warn'; }
    else if (starting) { text = 'Ieslēdz mikrofonu…'; kind = 'warn'; }
    else if (!active) { text = 'Restartē…'; kind = 'warn'; }
    else {
      var l = latencySummary(10);
      text = 'Klausās' + (l ? ' · ' + (l.shown / 1000).toFixed(1).replace('.', ',') + ' s' : '');
      kind = lastError ? (lastError.fatal ? 'err' : 'warn') : 'on';
    }
    statusEl.textContent = text;
    var sound = statusEl.classList.contains('sound');
    statusEl.className = 'status ' + kind + (sound && active ? ' sound' : '');
  }

  /* ---------- Wake lock ---------- */
  function lockScreen() {
    if (!('wakeLock' in navigator) || !running || document.hidden || wakeLock) return;
    navigator.wakeLock.request('screen').then(function (l) {
      wakeLock = l;
      log('wake lock on');
      l.addEventListener('release', function () {
        wakeLock = null;
        log('wake lock released');
        if (running && !document.hidden) setTimeout(lockScreen, 1000);
      });
    }).catch(function (e) { log('wake lock failed ' + (e && e.name)); });
  }
  function unlockScreen() {
    var l = wakeLock; wakeLock = null;
    if (l) { try { l.release(); } catch (e) {} }
  }
  document.addEventListener('visibilitychange', function () {
    log(document.hidden ? 'page hidden' : 'page visible');
    if (!running) return;
    if (document.hidden) { updateStatus(); return; }
    lockScreen();
    if (!active && !starting) scheduleRestart(200);
  });

  /* ---------- Start / stop ---------- */
  function start() {
    if (!SR) { showError('Šajā pārlūkā nav runas atpazīšanas. Izmanto Chrome Android ierīcē.', true); return; }
    if (S.engine === 'openai' && !hasKey()) {
      openSettings(); $('testResult').textContent = 'Vispirms ielīmē OpenAI API atslēgu.'; return;
    }
    if (S.engine === 'chrome' && !('Translator' in self)) {
      openSettings(); $('testResult').textContent = 'Chrome iebūvētais tulkotājs šajā ierīcē nav pieejams. Izvēlies OpenAI.'; return;
    }
    if (pendingRestore) restore(); // never lose an unsaved conversation by just pressing Start
    clearError(false);
    running = true; fails = 0; notAllowedCount = 0;
    log('START model=' + S.model + ' chunk=' + S.chunk + ' reveal=' + S.reveal + ' mode=' + S.mode);
    document.body.classList.add('running', 'started');
    showControls();
    warm();
    lockScreen();
    startRec();
    clearInterval(watchdog);
    watchdog = setInterval(function () {
      var act = C.watchdogAction({
        running: running, hidden: document.hidden, active: active, starting: starting,
        startCalledAt: startCalledAt, lastEventAt: lastEventAt, silentLimitMs: SILENT_LIMIT,
        restartPending: !!restartTimer, restartScheduledAt: restartScheduledAt
      }, Date.now());
      if (act === 'start') { log('watchdog: start'); startRec(); }
      else if (act === 'kick') { log('watchdog: kick'); lastEventAt = Date.now(); kick(); }
      if (running && !document.hidden && !wakeLock) lockScreen();
      if (running && Date.now() - lastApiAt > 40000) warm();
      updateStatus(); updateLag();
    }, 3000);
  }

  function stop() {
    running = false;
    log('STOP');
    clearTimeout(restartTimer); restartTimer = null;
    clearInterval(watchdog);
    if (rec) { try { rec.stop(); } catch (e) {} }
    setTimeout(function () { if (!running) { active = false; starting = false; updateStatus(); } }, 1500);
    unlockScreen();
    document.body.classList.remove('running');
    showControls();
    updateStatus(); updateLag();
  }

  $('startBtn').onclick = start;
  $('resumeBtn').onclick = start;
  $('stopBtn').onclick = stop;
  $('keyHint').onclick = function () { openSettings(); $('apiKey').focus(); };

  /* ---------- Controls: visible on tap, fade away while listening ---------- */
  var CALM_AFTER = 4000, calmTimer = null;
  function showControls() {
    document.body.classList.remove('calm');
    clearTimeout(calmTimer);
    calmTimer = setTimeout(function () {
      // only fade while listening, with nothing open and the view following live
      if (running && !frozen && !dlg.open && !$('saveDlg').open) document.body.classList.add('calm');
    }, CALM_AFTER);
  }
  feed.addEventListener('click', function () {
    if (document.body.classList.contains('calm')) showControls();
    else if (running) { clearTimeout(calmTimer); document.body.classList.add('calm'); }
  });
  $('dock').addEventListener('pointerdown', showControls);
  $('top').addEventListener('pointerdown', showControls);

  /* ---------- Text size (dock) ---------- */
  function setSize(v) { S.size = Math.max(24, Math.min(72, v)); save(); applyView(); }
  $('smaller').onclick = function () { setSize(S.size - 4); };
  $('bigger').onclick = function () { setSize(S.size + 4); };
  $('fullscreen').onclick = function () {
    if (document.fullscreenElement) document.exitFullscreen();
    else if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(function () {});
  };

  /* ---------- Settings dialog ---------- */
  function getRadio(name) { var el = document.querySelector('input[name=' + name + ']:checked'); return el ? el.value : ''; }
  function setRadio(name, v) {
    var el = document.querySelector('input[name=' + name + '][value="' + v + '"]');
    if (el) el.checked = true;
  }
  function openSettings() {
    setRadio('engine', S.engine);
    setRadio('theme', S.theme);
    setRadio('mode', S.mode);
    setRadio('chunk', S.chunk);
    setRadio('reveal', S.reveal);
    setRadio('correct', S.correct ? 'on' : 'off');
    $('corrModel').value = S.corrModel;
    $('glossary2').value = S.glossary;
    $('corrModelField').hidden = !S.correct;
    $('apiKey').value = S.apiKey;
    $('model').value = S.model;
    $('showEn').checked = !!S.showEn;
    $('sizeRange').value = S.size; $('sizeVal').textContent = S.size;
    $('lines').value = S.lines; $('linesVal').textContent = S.lines;
    $('capLines').value = S.capLines; $('capLinesVal').textContent = S.capLines;
    $('linesField').hidden = S.mode !== 'history';
    $('testResult').textContent = '';
    $('diag').hidden = true;
    $('chromeNote').textContent = ('Translator' in self)
      ? 'Chrome tulkotājs strādā ierīcē, bez maksas, bet bez konteksta un vājāk.'
      : 'Chrome iebūvētais tulkotājs šajā ierīcē nav pieejams (pagaidām parasti tikai datora Chrome).';
    if (dlg.showModal) dlg.showModal(); else dlg.setAttribute('open', '');
  }
  function readSettings() {
    var changed = S.apiKey !== $('apiKey').value.trim() || S.model !== ($('model').value.trim() || DEFAULTS.model);
    S.engine = getRadio('engine') || S.engine;
    S.theme = getRadio('theme') || S.theme;
    S.mode = getRadio('mode') || S.mode;
    S.chunk = getRadio('chunk') || S.chunk;
    S.reveal = getRadio('reveal') || S.reveal;
    if (getRadio('correct')) S.correct = getRadio('correct') === 'on';
    S.corrModel = $('corrModel').value.trim() || DEFAULTS.corrModel;
    setGlossary($('glossary2').value);
    $('corrModelField').hidden = !S.correct;
    S.apiKey = $('apiKey').value.trim();
    S.model = $('model').value.trim() || DEFAULTS.model;
    S.showEn = $('showEn').checked;
    S.size = +$('sizeRange').value || S.size;
    S.lines = +$('lines').value;
    S.capLines = +$('capLines').value;
    $('linesField').hidden = S.mode !== 'history';
    chromeTranslator = null;
    if (changed) { clearError(false); if (running) warm(); }
    save(); applyView();
  }
  $('openSettings').onclick = openSettings;

  /* Meeting topic / glossary: one value, editable on the start screen and in settings. */
  function setGlossary(v) {
    S.glossary = (v || '').slice(0, 600);
    if ($('glossary').value !== S.glossary) $('glossary').value = S.glossary;
    if ($('glossary2').value !== S.glossary) $('glossary2').value = S.glossary;
    save();
  }
  $('glossary').value = S.glossary;
  $('glossary').addEventListener('input', function (e) { setGlossary(e.target.value); });
  $('lines').oninput = function (e) { $('linesVal').textContent = e.target.value; };
  $('capLines').oninput = function (e) { $('capLinesVal').textContent = e.target.value; };
  $('sizeRange').oninput = function (e) { $('sizeVal').textContent = e.target.value; };
  // settings apply immediately (live preview behind the sheet)
  $('settingsForm').addEventListener('change', readSettings);
  dlg.addEventListener('close', readSettings);

  var SAMPLE = 'so the main issue with the current supplier is';
  $('testKey').onclick = function () {
    readSettings();
    var out = $('testResult');
    out.textContent = 'Pārbauda…';
    var t0 = Date.now(), first = 0;
    var p = S.engine === 'chrome' ? chromeTranslate(SAMPLE) :
      openaiStream(C.buildChunkBody(S.model, SAMPLE, '', '', false), function (t) {
        if (!first) first = Date.now(); out.textContent = t;
      });
    p.then(function (full) {
      out.textContent = 'Darbojas. Pirmais vārds ' + ((first || Date.now()) - t0) + ' ms: ' + full;
      clearError(false);
    }).catch(function (e) { out.textContent = 'Kļūda: ' + e.message; });
  };

  /* Measures time to first translated word for several models, on this phone and network. */
  $('speedTest').onclick = function () {
    readSettings();
    var out = $('testResult');
    if (S.engine !== 'openai' || !hasKey()) { out.textContent = 'Ātruma testam vajag OpenAI atslēgu.'; return; }
    var models = ['gpt-4.1-nano', 'gpt-4.1-mini', 'gpt-4o-mini', 'gpt-5-nano'];
    if (models.indexOf(S.model) < 0) models.unshift(S.model);
    var lines = [];
    out.textContent = 'Mēra (katram modelim 2 reizes)…';
    var chain = Promise.resolve();
    models.forEach(function (m) {
      chain = chain.then(function () {
        var times = [], text = '';
        function once() {
          var t0 = Date.now(), first = 0;
          return openaiStream(C.buildChunkBody(m, SAMPLE, 'we looked at three offers last week', 'pagājušajā nedēļā apskatījām trīs piedāvājumus', false),
            function () { if (!first) first = Date.now(); }, { timeoutMs: 15000, stallMs: 8000 })
            .then(function (t) { times.push((first || Date.now()) - t0); text = t; });
        }
        return once().then(once).then(function () {
          lines.push(m + ': ' + Math.min.apply(null, times) + ' ms  "' + text + '"');
        }, function (e) {
          lines.push(m + ': nav pieejams (' + e.message + ')');
        }).then(function () { out.textContent = lines.join('\n') + '\n…'; });
      });
    });
    chain.then(function () {
      out.textContent = 'Laiks līdz pirmajam tulkotajam vārdam (labākais no 2):\n' + lines.join('\n') +
        '\nIzvēlies ātrāko, kura tulkojums izskatās labi, un ieraksti to laukā Modelis.';
      clearError(false);
    });
  };

  $('showDiag').onclick = function () {
    var d = $('diag'), l = latencySummary(30);
    d.hidden = !d.hidden;
    d.textContent =
      (l ? 'Aizture (mediāna, pēdējie ' + l.n + ' gabali):\n' +
        '  runa atpazīta → pirmais vārds uz ekrāna: ' + l.shown + ' ms\n' +
        '    gaidīšana uz frāzi: ' + l.wait + ' ms\n' +
        '    OpenAI līdz pirmajam vārdam: ' + l.api + ' ms\n' +
        '    rinda uz ekrāna (lasīšanas temps): ' + Math.max(0, l.shown - l.net) + ' ms\n' +
        '  (+ Google runas atpazīšana, ap 300 līdz 700 ms, nav izmērāma)\n' +
        '  rindā gaida: ' + backlog() + ' vārdi\n\n'
        : 'Aizture: vēl nav datu\n\n') +
      'Labošana pēc konteksta: ' + (S.correct ? 'ieslēgta (' + S.corrModel + ')' : 'izslēgta') +
      ', pārbaudīts ' + corrStats.sent + ', labots ' + corrStats.changed +
      ' (no tiem ārpus ekrāna ' + corrStats.offscreen + '), bez izmaiņām ' + corrStats.kept +
      ', kļūdas ' + corrStats.failed + '\n' +
      (corrStats.last.length ? corrStats.last.slice().reverse().map(function (x) { return '  ' + x; }).join('\n') + '\n' : '') + '\n' +
      'running=' + running + ' active=' + active + ' starting=' + starting +
      ' inflight=' + inflight + ' fails=' + fails + ' wakeLock=' + !!wakeLock +
      ' model=' + S.model + ' chunk=' + S.chunk + ' reveal=' + S.reveal + '\n' +
      (diag.length ? diag.slice().reverse().join('\n') : '(tukšs)');
  };
  /* ---------- Save dialog (v5) ---------- */
  var saveDlg = $('saveDlg'), saveResult = $('saveResult');
  var newConvArmed = false;

  function radio(name) { var el = document.querySelector('input[name=' + name + ']:checked'); return el ? el.value : ''; }

  function buildExport() {
    persistNow();
    var withEn = radio('saveLang') !== 'lv';
    var html = radio('saveFmt') === 'html';
    var content = html ? C.transcriptHtml(store, withEn) : C.transcriptText(store, withEn);
    var name = C.transcriptFilename(store.startedAt || Date.now(), html ? 'html' : 'txt');
    var type = html ? 'text/html' : 'text/plain';
    return { content: content, name: name, type: type };
  }

  function openSave() {
    var st = C.transcriptStats(store);
    newConvArmed = false;
    $('newConv').textContent = 'Jauna saruna';
    saveResult.textContent = '';
    $('saveInfo').textContent = st.count
      ? 'Sākums ' + C.formatDateTime(new Date(store.startedAt)) + ', ' + C.formatDuration(st.durationMs) +
        ', ' + C.plural(st.count, 'runas daļa', 'runas daļas') + ', ' + C.plural(st.words, 'vārds', 'vārdi') + '.' + (dirty ? '' : ' Jau saglabāts.')
      : 'Saruna vēl ir tukša.';
    ['saveShare', 'saveDownload', 'saveCopy'].forEach(function (id) { $(id).disabled = !st.count; });
    if (saveDlg.showModal) saveDlg.showModal(); else saveDlg.setAttribute('open', '');
  }

  function markSaved(how) {
    dirty = false; persistNow();
    saveResult.textContent = how;
    log('saved: ' + how);
  }

  function download(ex) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([ex.content], { type: ex.type + ';charset=utf-8' }));
    a.download = ex.name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 10000);
    markSaved('Lejupielādēts: ' + ex.name);
  }

  /* Android Chrome: share sheet with the file (Drive, e-mail, Telegram...). Else download. */
  $('saveShare').onclick = function () {
    var ex = buildExport(), file = null;
    try { file = new File([ex.content], ex.name, { type: ex.type }); } catch (e) {}
    if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
      navigator.share({ files: [file], title: ex.name }).then(function () {
        markSaved('Nosūtīts: ' + ex.name);
      }).catch(function (e) {
        if (e && e.name === 'AbortError') { saveResult.textContent = 'Dalīšanās atcelta.'; return; }
        download(ex);
      });
    } else {
      download(ex);
    }
  };
  $('saveDownload').onclick = function () { download(buildExport()); };
  $('saveCopy').onclick = function () {
    var withEn = radio('saveLang') !== 'lv';
    var text = C.transcriptText(store, withEn);
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      saveDlg.appendChild(ta); ta.select();
      var ok = false; try { ok = document.execCommand('copy'); } catch (e) {}
      ta.remove();
      if (ok) markSaved('Nokopēts starpliktuvē.'); else saveResult.textContent = 'Neizdevās nokopēt.';
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { markSaved('Nokopēts starpliktuvē.'); }, fallback);
    } else fallback();
  };

  function newConversation() {
    endUtter();
    $('clearText').onclick();
    store = { startedAt: 0, records: [] };
    segs = [];
    dirty = false;
    clearStored();
    lastSegEndAt = 0;
    log('new conversation');
  }
  $('newConv').onclick = function () {
    var st = C.transcriptStats(store);
    if (st.count && dirty && !newConvArmed) {
      newConvArmed = true;
      this.textContent = 'Dzēst bez saglabāšanas';
      saveResult.textContent = 'Šī saruna vēl nav saglabāta. Vispirms nospied "Saglabāt / dalīties", vai nospied vēlreiz, lai dzēstu.';
      return;
    }
    newConversation();
    saveDlg.close();
  };
  $('openSave').onclick = openSave;
  $('saveText').onclick = function () { dlg.close(); openSave(); };

  /* ---------- Restore after reload ---------- */
  var pendingRestore = loadStored();
  function restore() {
    if (!pendingRestore) return;
    store = { startedAt: pendingRestore.startedAt, records: pendingRestore.records };
    dirty = pendingRestore.dirty !== false;
    renderRestored(store.records);
    pendingRestore = null;
    $('restoreBar').hidden = true;
    log('restored ' + store.records.length + ' segments');
  }
  if (pendingRestore) {
    var rs = C.transcriptStats(pendingRestore);
    $('restoreText').textContent = 'Atrasta iepriekšējā saruna: sākums ' +
      C.formatDateTime(new Date(pendingRestore.startedAt)) + ', ' + C.plural(rs.count, 'runas daļa', 'runas daļas') + '.';
    $('restoreBar').hidden = false;
  }
  $('restoreYes').onclick = restore;
  $('restoreNo').onclick = function () {
    if (pendingRestore && pendingRestore.dirty !== false &&
        !confirm('Iepriekšējā saruna nav saglabāta. Atjaunot to, lai saglabātu? (Atcelt = dzēst)')) {
      pendingRestore = null; clearStored(); $('restoreBar').hidden = true; return;
    }
    if (pendingRestore && pendingRestore.dirty !== false) { restore(); openSave(); return; }
    pendingRestore = null; clearStored(); $('restoreBar').hidden = true;
  };
  $('clearText').onclick = function () {
    endUtter();
    // mark everything as already shown, then empty the screen
    chunks.forEach(function (c) { c.revealed = 1e9; c.done = true; });
    revealIdx = chunks.length;
    domSegs.forEach(function (s) { s.el = null; });
    domSegs = [];
    while (capText.firstChild) capText.removeChild(capText.firstChild);
    capText.appendChild(caret);
    liveChunk = null; lastRevealed = '';
    liveEn.textContent = '';
    unfreeze(false);
    if (!running) document.body.classList.remove('started'); // back to the start screen
    updateStatus();
    updateLag();
  };

  /* ---------- Init ---------- */
  applyView();
  updateStatus();
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(function () {});
  }
  // test hook (harmless in production): lets the browser harness read numbers
  window.__tulks = {
    latencySummary: latencySummary, chunks: chunks, revealLog: [],
    backlog: backlog, isFrozen: function () { return frozen; }, freeze: freeze,
    fixLog: [], corrStats: function () { return corrStats; },
    store: function () { return store; }, isDirty: function () { return dirty; }, persistNow: persistNow
  };
})();
