/* Sapulces tulks v3: live EN -> LV captions. Plain JS, no build step.
 *
 * Pipeline: Chrome speech recognition (interim words) -> chunker commits short
 * stable fragments (~4 words, or at a pause) -> each fragment is translated at once
 * (parallel requests, streamed) -> appended to the screen in order, never rewritten.
 */
(function () {
  'use strict';
  var C = window.TCore;
  var $ = function (id) { return document.getElementById(id); };

  /* ---------- Settings (localStorage only) ---------- */
  var SETTINGS_VERSION = 3;
  var DEFAULTS = {
    v: SETTINGS_VERSION, apiKey: '', model: 'gpt-4.1-mini', engine: 'openai',
    showEn: false, light: false, size: 40, lines: 7, capLines: 5,
    mode: 'captions', chunk: 'short'
  };
  var S = load();
  function load() {
    var s = {};
    try { s = JSON.parse(localStorage.getItem('tulks.settings') || '{}'); } catch (e) {}
    if (s.v !== SETTINGS_VERSION) { // v3 introduced captions: switch older installs to it once
      delete s.mode; delete s.interim;
      if (s.size && s.size > 48) delete s.size;
    }
    var out = {};
    for (var k in DEFAULTS) out[k] = (k in s) ? s[k] : DEFAULTS[k];
    out.v = SETTINGS_VERSION;
    return out;
  }
  function save() {
    try { localStorage.setItem('tulks.settings', JSON.stringify(S)); } catch (e) {}
  }
  function preset() { return C.CHUNK_PRESETS[S.chunk] || C.CHUNK_PRESETS.short; }

  /* ---------- Diagnostics ---------- */
  var diag = [];
  function log(msg) {
    diag.push(new Date().toTimeString().slice(0, 8) + ' ' + msg);
    if (diag.length > 80) diag.shift();
  }
  var lat = []; // {wait, api, total} per chunk, ms
  function recordLatency(c) {
    var x = { wait: c.commitAt - c.seenAvg, api: c.firstAt - c.commitAt, total: c.firstAt - c.seenAvg };
    lat.push(x);
    if (lat.length > 200) lat.shift();
    updateStatus();
  }
  function latencySummary(n) {
    var a = lat.slice(-(n || 30));
    if (!a.length) return null;
    return {
      n: a.length,
      total: C.median(a.map(function (x) { return x.total; })),
      wait: C.median(a.map(function (x) { return x.wait; })),
      api: C.median(a.map(function (x) { return x.api; }))
    };
  }

  /* ---------- Elements ---------- */
  var feed = $('feed'), capText = $('capText'), caret = $('caret'), liveEn = $('liveEn');
  var statusEl = $('status'), btn = $('startStop'), dlg = $('settings');
  var errorBar = $('errorBar'), errorText = $('errorText');
  var MODES = ['captions', 'focus', 'history'];
  var MODE_LABEL = { captions: 'CC', focus: '1', history: '≡' };

  function applyView() {
    var root = document.documentElement.style;
    root.setProperty('--size', S.size + 'px');
    root.setProperty('--caplines', S.capLines);
    var b = document.body.classList;
    b.toggle('light', !!S.light);
    b.toggle('show-en', !!S.showEn);
    MODES.forEach(function (m) { b.toggle('mode-' + m, S.mode === m); });
    $('toggleEn').classList.toggle('on', !!S.showEn);
    $('toggleMode').textContent = MODE_LABEL[S.mode] || 'CC';
    document.querySelector('meta[name=theme-color]').content = S.light ? '#ffffff' : '#000000';
    prevCapH = 0;
    layout();
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

  /* ---------- Segments and chunks (the screen model) ----------
   * seg  = one utterance (between recognizer finals), holds chunks.
   * chunk = a translated fragment. Its text only ever grows while streaming. */
  var segs = [];    // {el, lvEl, enEl, en, chunks: []}
  var chunks = [];  // all chunks in spoken order
  var lastSegEndAt = 0;
  var liveIndex = -1;

  function newSeg() {
    document.body.classList.add('started');
    var prev = segs[segs.length - 1];
    if (prev) {
      if (Date.now() - lastSegEndAt > 2500) {
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
    var seg = { el: el, lvEl: el.firstChild, enEl: el.lastChild, en: '', chunks: [] };
    seg.lvEl.appendChild(caret);
    segs.push(seg);
    trimDom();
    layout();
    return seg;
  }

  function addChunk(seg, en, seenAvg, endsSentence) {
    var span = document.createElement('span');
    span.className = 'chunk';
    if (seg.chunks.length) seg.lvEl.insertBefore(document.createTextNode(' '), caret.parentNode === seg.lvEl ? caret : null);
    seg.lvEl.insertBefore(span, caret.parentNode === seg.lvEl ? caret : null);
    var c = { el: span, en: en, lv: '', index: chunks.length, seg: seg, endsSentence: endsSentence,
      seenAvg: seenAvg, commitAt: Date.now(), firstAt: 0, done: false };
    chunks.push(c);
    seg.chunks.push(c);
    translateChunk(c, 0);
    return c;
  }

  function setLive(c) {
    if (c.index <= liveIndex) return;
    var old = chunks[liveIndex];
    if (old) old.el.classList.remove('live');
    liveIndex = c.index;
    c.el.classList.add('live');
  }

  function trimDom() {
    var max = S.mode === 'history' ? S.lines + 20 : 40;
    while (segs.length > max) {
      var s = segs.shift();
      while (capText.firstChild && capText.firstChild !== s.el) capText.removeChild(capText.firstChild);
      capText.removeChild(s.el);
    }
  }

  /* Smoothly scroll the caption window when a new line appears (no jump). */
  var prevCapH = 0;
  function smoothShift() {
    if (S.mode !== 'captions') return;
    var h = capText.offsetHeight;
    if (prevCapH && h > prevCapH + 2) {
      var d = h - prevCapH;
      capText.style.transition = 'none';
      capText.style.transform = 'translateY(' + d + 'px)';
      void capText.offsetHeight;
      capText.style.transition = 'transform 260ms cubic-bezier(.2,.7,.3,1)';
      capText.style.transform = 'translateY(0)';
    }
    prevCapH = h;
  }

  function layout() {
    if (S.mode === 'captions') {
      segs.forEach(function (s) { s.el.style.display = ''; s.el.style.opacity = ''; s.el.classList.remove('current', 'prev'); });
      smoothShift();
      return;
    }
    capText.style.transform = '';
    var styles = C.lineStyles(S.mode, segs.length, S.lines);
    for (var i = 0; i < segs.length; i++) {
      var el = segs[i].el, st = styles[i];
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

  function hasKey() { return S.apiKey && S.apiKey.trim().length > 20; }

  function makeErr(status, body, cancelled, model) {
    var info = C.classifyError(status, body, model || S.model);
    var e = new Error(info.msg);
    e.status = status; e.info = info; e.cancelled = !!cancelled;
    return e;
  }

  /* Streamed chat completion with total + stall timeouts. Always settles. */
  function openaiStream(body, onDelta, opts) {
    if (!hasKey()) return Promise.reject(makeErr(401, '{}'));
    opts = opts || {};
    var ctrl = new AbortController(), reason = '';
    function abort(why) { if (!reason) { reason = why; try { ctrl.abort(); } catch (e) {} } }
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
    for (var i = Math.max(0, c.index - 4); i < c.index; i++) {
      en.push(chunks[i].en);
      if (chunks[i].lv) lv.push(chunks[i].lv);
    }
    return { en: en.join(' '), lv: lv.join(' ') };
  }

  /* Display-only capitalization: first chunk ever, or the previous chunk ended a sentence. */
  function startsSentence(c) {
    var prev = chunks[c.index - 1];
    return !prev || /[.!?]["')]*\s*$/.test(prev.lv || '');
  }

  function translateChunk(c, attempt) {
    var ctx = contextBefore(c);
    var onDelta = function (partial) {
      if (!c.firstAt) { c.firstAt = Date.now(); if (attempt === 0) recordLatency(c); }
      if (startsSentence(c)) partial = partial.charAt(0).toUpperCase() + partial.slice(1);
      c.lv = partial;
      c.el.textContent = partial;
      setLive(c);
      layout();
    };
    var p = S.engine === 'chrome'
      ? chromeTranslate(c.en).then(function (t) { onDelta(t); return t; })
      : openaiStream(C.buildChunkBody(S.model || DEFAULTS.model, c.en, ctx.en, ctx.lv, c.endsSentence), onDelta,
        { timeoutMs: 10000, stallMs: 5000 });
    p.then(function (full) {
      c.done = true;
      c.lv = full || c.lv;
      c.el.textContent = c.lv;
      if (!c.lv) { c.el.textContent = c.en; c.el.classList.add('failed'); }
      clearError(false);
      layout();
    }, function (e) {
      var info = e.info || { msg: String(e.message || e), retry: false, fatal: false };
      log('chunk #' + c.index + ' fail ' + attempt + ' status=' + e.status);
      if (info.retry && attempt < 2) {
        showError(info.msg, false);
        c.firstAt = 0;
        setTimeout(function () { translateChunk(c, attempt + 1); }, C.retryDelay(attempt) / 2);
        return;
      }
      showError(info.msg, info.fatal);
      if (!c.lv) { c.el.textContent = c.en; c.el.classList.add('failed'); } // English beats nothing
      layout();
    });
  }

  /* ---------- Chunker: turns recognizer words into fragments ---------- */
  var utter = null; // {seg, words, committed, seenAt, lastChangeAt, text}
  var pauseTimer = null;

  function ensureUtter() {
    if (!utter) utter = { seg: newSeg(), words: [], committed: 0, seenAt: [], lastChangeAt: Date.now(), text: '' };
    return utter;
  }

  function setWords(text) {
    var u = ensureUtter(), now = Date.now();
    var words = text.trim().split(/\s+/).filter(Boolean);
    for (var i = 0; i < words.length; i++) if (u.seenAt[i] == null) u.seenAt[i] = now;
    if (text !== u.text) { u.text = text; u.lastChangeAt = now; }
    u.words = words;
    u.seg.en = words.join(' ');
    u.seg.enEl.textContent = u.seg.en;
    liveEn.textContent = C.tail(u.seg.en, 90);
  }

  function runChunker(event) {
    var u = utter;
    if (!u) return;
    var p = preset();
    for (var guard = 0; guard < 10; guard++) {
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

  function onFinalText(text) {
    setWords(text);
    runChunker('final');
    endUtter();
  }

  function endUtter() {
    clearTimeout(pauseTimer);
    if (utter) {
      runChunker('final');
      if (!utter.seg.chunks.length && !utter.words.length) {
        // empty segment: remove it and its separator
        var el = utter.seg.el;
        if (el.previousSibling && el.previousSibling !== caret) capText.removeChild(el.previousSibling);
        capText.removeChild(el);
        segs.pop();
        var last = segs[segs.length - 1];
        if (last) last.lvEl.appendChild(caret);
      }
      lastSegEndAt = Date.now();
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
    r.maxAlternatives = 1;
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
        if (part) onFinalText(part);
      } else interimText += t;
    }
    interimText = C.newFinalPart(lastFinalRaw, interimText.trim());
    if (interimText) onInterimText(interimText);
  }

  function updateStatus() {
    var text, kind;
    if (!SR) { text = 'Nav runas atpazīšanas'; kind = 'err'; }
    else if (!running) { text = lastError && lastError.fatal ? 'Apturēts (kļūda)' : 'Apturēts'; kind = lastError && lastError.fatal ? 'err' : 'off'; }
    else if (document.hidden) { text = 'Fonā, apturēts'; kind = 'warn'; }
    else if (starting) { text = 'Ieslēdz mikrofonu…'; kind = 'warn'; }
    else if (!active) { text = 'Restartē…'; kind = 'warn'; }
    else {
      var l = latencySummary(10);
      text = 'Klausās' + (l ? ' · ' + (l.total / 1000).toFixed(1).replace('.', ',') + ' s' : '');
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
    clearError(false);
    running = true; fails = 0; notAllowedCount = 0;
    log('START model=' + S.model + ' chunk=' + S.chunk + ' mode=' + S.mode);
    document.body.classList.add('running', 'started');
    btn.textContent = 'Apturēt'; btn.className = 'big stop';
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
      updateStatus();
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
    btn.textContent = 'Sākt'; btn.className = 'big start';
    updateStatus();
  }

  btn.addEventListener('click', function () { running ? stop() : start(); });

  /* ---------- Toolbar ---------- */
  function setSize(v) { S.size = Math.max(20, Math.min(110, v)); save(); applyView(); }
  $('smaller').onclick = function () { setSize(S.size - 4); };
  $('bigger').onclick = function () { setSize(S.size + 4); };
  $('toggleEn').onclick = function () { S.showEn = !S.showEn; save(); applyView(); };
  $('toggleTheme').onclick = function () { S.light = !S.light; save(); applyView(); };
  $('toggleMode').onclick = function () {
    S.mode = MODES[(MODES.indexOf(S.mode) + 1) % MODES.length]; save(); applyView();
  };
  $('fullscreen').onclick = function () {
    if (document.fullscreenElement) document.exitFullscreen();
    else if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(function () {});
  };

  /* ---------- Settings dialog ---------- */
  function openSettings() {
    $('engine').value = S.engine;
    $('apiKey').value = S.apiKey;
    $('model').value = S.model;
    $('mode').value = S.mode;
    $('chunk').value = S.chunk;
    $('showEn').checked = !!S.showEn;
    $('lightTheme').checked = !!S.light;
    $('lines').value = S.lines; $('linesVal').textContent = S.lines;
    $('capLines').value = S.capLines; $('capLinesVal').textContent = S.capLines;
    $('testResult').textContent = '';
    $('diag').hidden = true;
    $('chromeNote').textContent = ('Translator' in self)
      ? 'Chrome tulkotājs strādā ierīcē, bez maksas, bet bez konteksta un vājāk.'
      : 'Chrome iebūvētais tulkotājs šajā ierīcē nav pieejams (pagaidām parasti tikai datora Chrome).';
    if (dlg.showModal) dlg.showModal(); else dlg.setAttribute('open', '');
  }
  function readSettings() {
    var changed = S.apiKey !== $('apiKey').value.trim() || S.model !== ($('model').value.trim() || DEFAULTS.model);
    S.engine = $('engine').value;
    S.apiKey = $('apiKey').value.trim();
    S.model = $('model').value.trim() || DEFAULTS.model;
    S.mode = $('mode').value;
    S.chunk = $('chunk').value;
    S.showEn = $('showEn').checked;
    S.light = $('lightTheme').checked;
    S.lines = +$('lines').value;
    S.capLines = +$('capLines').value;
    chromeTranslator = null;
    if (changed) { clearError(false); if (running) warm(); }
    save(); applyView();
  }
  $('openSettings').onclick = openSettings;
  $('lines').oninput = function (e) { $('linesVal').textContent = e.target.value; };
  $('capLines').oninput = function (e) { $('capLinesVal').textContent = e.target.value; };
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
        '  runa atpazīta → tulkojums uz ekrāna: ' + l.total + ' ms\n' +
        '    no tā gaidīšana uz frāzi: ' + l.wait + ' ms\n' +
        '    OpenAI līdz pirmajam vārdam: ' + l.api + ' ms\n' +
        '  (+ Google runas atpazīšana, ap 300 līdz 700 ms, nav izmērāma)\n\n'
        : 'Aizture: vēl nav datu\n\n') +
      'running=' + running + ' active=' + active + ' starting=' + starting +
      ' inflight=' + inflight + ' fails=' + fails + ' wakeLock=' + !!wakeLock +
      ' model=' + S.model + ' chunk=' + S.chunk + '\n' +
      (diag.length ? diag.slice().reverse().join('\n') : '(tukšs)');
  };
  $('saveText').onclick = function () {
    var data = segs.filter(function (s) { return s.en; });
    if (!data.length) { $('testResult').textContent = 'Stenogramma ir tukša.'; return; }
    var txt = data.map(function (s) {
      return 'EN: ' + s.en + '\nLV: ' + s.chunks.map(function (c) { return c.lv || c.en; }).join(' ');
    }).join('\n\n');
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([txt], { type: 'text/plain;charset=utf-8' }));
    a.download = 'sapulce-' + new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-') + '.txt';
    document.body.appendChild(a); a.click(); a.remove();
  };
  $('clearText').onclick = function () {
    endUtter();
    segs.forEach(function (s) { s.el.remove(); });
    while (capText.firstChild) capText.removeChild(capText.firstChild);
    capText.appendChild(caret);
    segs = []; liveIndex = chunks.length - 1; prevCapH = 0;
    liveEn.textContent = '';
  };

  /* ---------- Init ---------- */
  applyView();
  updateStatus();
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(function () {});
  }
  // test hook (harmless in production): lets the browser harness read latency numbers
  window.__tulks = { latencySummary: latencySummary, chunks: chunks };
})();
