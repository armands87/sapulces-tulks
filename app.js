/* Sapulces tulks: live EN -> LV translation. Plain JS, no build step. */
(function () {
  'use strict';
  var C = window.TCore;
  var $ = function (id) { return document.getElementById(id); };

  /* ---------- Settings (localStorage only) ---------- */
  var DEFAULTS = {
    apiKey: '', model: 'gpt-4.1-mini', engine: 'openai', interim: true,
    showEn: false, light: false, size: 44, lines: 7, mode: 'focus'
  };
  var S = load();
  function load() {
    var s = {};
    try { s = JSON.parse(localStorage.getItem('tulks.settings') || '{}'); } catch (e) {}
    var out = {};
    for (var k in DEFAULTS) out[k] = (k in s) ? s[k] : DEFAULTS[k];
    return out;
  }
  function save() {
    try { localStorage.setItem('tulks.settings', JSON.stringify(S)); } catch (e) {}
  }

  /* ---------- Diagnostics log (shown in settings) ---------- */
  var diag = [];
  function log(msg) {
    var t = new Date().toTimeString().slice(0, 8);
    diag.push(t + ' ' + msg);
    if (diag.length > 60) diag.shift();
  }

  /* ---------- Elements ---------- */
  var feed = $('feed'), statusEl = $('status'), btn = $('startStop'), dlg = $('settings');
  var errorBar = $('errorBar'), errorText = $('errorText');

  function applyView() {
    document.documentElement.style.setProperty('--size', S.size + 'px');
    $('size').value = S.size;
    document.body.classList.toggle('light', !!S.light);
    document.body.classList.toggle('show-en', !!S.showEn);
    document.body.classList.toggle('mode-focus', S.mode === 'focus');
    document.body.classList.toggle('mode-history', S.mode !== 'focus');
    $('toggleEn').classList.toggle('on', !!S.showEn);
    $('toggleMode').textContent = S.mode === 'focus' ? '1' : '≡';
    $('toggleMode').setAttribute('aria-label', S.mode === 'focus'
      ? 'Režīms: tikai pašreizējais teikums' : 'Režīms: visa vēsture');
    document.querySelector('meta[name=theme-color]').content = S.light ? '#ffffff' : '#000000';
    layout();
  }

  /* ---------- Errors and status ---------- */
  var lastError = null; // {msg, fatal, at}

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

  /* ---------- Feed rendering ---------- */
  var history = [];       // finished lines {en, lv, t}
  var currentLine = null; // interim line element

  function createLine() {
    var hint = $('hint');
    if (hint) hint.remove();
    var el = document.createElement('div');
    el.className = 'line interim';
    el.innerHTML = '<div class="lv"></div><div class="en"></div>';
    el._seq = 0;
    feed.appendChild(el);
    layout();
    return el;
  }

  function layout() {
    var lines = feed.querySelectorAll('.line');
    var keep = (S.mode === 'focus' ? 2 : S.lines) + 20;
    var styles = C.lineStyles(S.mode, lines.length, S.lines);
    for (var i = 0; i < lines.length; i++) {
      var el = lines[i], st = styles[i];
      if (lines.length - 1 - i >= keep) { el.remove(); continue; }
      el.style.display = st.show ? '' : 'none';
      el.style.opacity = st.show ? String(st.opacity) : '';
      el.classList.toggle('current', st.role === 'current');
      el.classList.toggle('prev', st.role === 'prev');
    }
    feed.scrollTop = feed.scrollHeight;
  }

  /* ---------- Translation ---------- */
  var chromeTranslator = null;
  var inflight = 0;

  function hasKey() { return S.apiKey && S.apiKey.trim().length > 20; }

  function makeErr(status, body, cancelled) {
    var info = C.classifyError(status, body, S.model);
    var e = new Error(info.msg);
    e.status = status; e.info = info; e.cancelled = !!cancelled;
    return e;
  }

  /*
   * One translation request with: overall timeout, stall timeout (no stream
   * chunk for stallMs), and cancel via external signal. Always settles.
   */
  function translate(text, context, onDelta, opts) {
    opts = opts || {};
    inflight++; updateStatus();
    var p = S.engine === 'chrome' ? translateChrome(text, onDelta, opts) : translateOpenAI(text, context, onDelta, opts);
    return p.then(function (r) { inflight--; updateStatus(); return r; },
      function (e) { inflight--; updateStatus(); throw e; });
  }

  function translateOpenAI(text, context, onDelta, opts) {
    if (!hasKey()) return Promise.reject(makeErr(401, '{}'));
    var ctrl = new AbortController();
    var reason = '';
    function abort(why) { if (!reason) { reason = why; try { ctrl.abort(); } catch (e) {} } }
    var total = setTimeout(function () { abort('timeout'); }, opts.timeoutMs || 15000);
    var stall = null;
    function armStall() {
      clearTimeout(stall);
      stall = setTimeout(function () { abort('stall'); }, opts.stallMs || 7000);
    }
    if (opts.signal) {
      if (opts.signal.aborted) abort('cancel');
      else opts.signal.addEventListener('abort', function () { abort('cancel'); });
    }
    armStall();
    function done() { clearTimeout(total); clearTimeout(stall); }

    return fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + S.apiKey.trim() },
      body: JSON.stringify(C.buildBody(S.model || DEFAULTS.model, text, context, true)),
      signal: ctrl.signal
    }).then(function (res) {
      if (!res.ok) {
        return res.text().catch(function () { return ''; }).then(function (t) { throw makeErr(res.status, t); });
      }
      armStall();
      var reader = res.body.getReader();
      var dec = new TextDecoder();
      var parser = new C.SSEParser();
      var full = '';
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
      done();
      return full.trim();
    }, function (e) {
      done();
      if (e && e.info) throw e;                 // HTTP error already classified
      if (reason === 'cancel') throw makeErr(0, '', true);
      throw makeErr(0, '');                     // network, timeout or stall
    });
  }

  function translateChrome(text, onDelta, opts) {
    var get = chromeTranslator ? Promise.resolve(chromeTranslator) :
      self.Translator.create({ sourceLanguage: 'en', targetLanguage: 'lv' }).then(function (t) {
        chromeTranslator = t; return t;
      });
    var work = get.then(function (t) { return t.translate(text); }).then(function (out) { onDelta(out); return out; });
    var timeout = new Promise(function (_, rej) {
      setTimeout(function () { rej(makeErr(0, '')); }, opts.timeoutMs || 15000);
    });
    return Promise.race([work, timeout]).catch(function (e) {
      if (e && e.info) throw e;
      var err = new Error('Chrome tulkotāja kļūda: ' + (e && e.message));
      err.info = { msg: err.message, retry: false, fatal: false }; err.status = -1;
      throw err;
    });
  }

  function contextFor() {
    return history.slice(-3).map(function (h) { return h.en; });
  }

  /* Interim translation: max one request at a time, throttled, never blocks finals. */
  var interim = { busy: false, lastText: '', lastAt: 0, ctrl: null, timer: null, pendingText: '' };
  var INTERIM_GAP = 1200;

  function maybeTranslateInterim(line, text) {
    interim.pendingText = text;
    if (!S.interim || interim.busy) return;
    if (lastError && lastError.fatal) return;
    if (S.engine === 'openai' && !hasKey()) return;
    var now = Date.now();
    if (!C.shouldTranslateInterim(text, interim.lastText, interim.lastAt, now, INTERIM_GAP)) {
      if (text !== interim.lastText) scheduleInterimCheck(line, Math.max(150, INTERIM_GAP - (now - interim.lastAt)));
      return;
    }
    interim.busy = true;
    interim.lastText = text;
    interim.lastAt = now;
    var seq = ++line._seq;
    var ctrl = new AbortController();
    interim.ctrl = ctrl;
    translate(text, contextFor(), function (partial) {
      if (line._seq === seq && line.classList.contains('interim')) {
        line.querySelector('.lv').textContent = partial; layout();
      }
    }, { signal: ctrl.signal, timeoutMs: 6000, stallMs: 4000 }).then(function () {
      clearError(true);
    }, function (e) {
      if (!e.cancelled && e.info && e.info.fatal) showError(e.info.msg, true);
      // non-fatal interim errors are ignored: the final translation will retry
    }).then(function () {
      if (interim.ctrl !== ctrl) return; // line was closed meanwhile
      interim.busy = false; interim.ctrl = null;
      // speech kept coming while we were busy: catch up
      if (currentLine === line && interim.pendingText && interim.pendingText !== interim.lastText) {
        scheduleInterimCheck(line, 50);
      }
    });
  }

  function scheduleInterimCheck(line, ms) {
    clearTimeout(interim.timer);
    interim.timer = setTimeout(function () {
      if (currentLine === line && interim.pendingText) maybeTranslateInterim(line, interim.pendingText);
    }, ms);
  }

  function translateFinal(line, text, entry, attempt) {
    attempt = attempt || 0;
    if (!entry) {
      entry = { en: text, lv: '', t: new Date() };
      history.push(entry);
    }
    var ctx = contextFor().filter(function (s) { return s !== text; });
    line.classList.add('waiting');
    line.classList.remove('error');
    var seq = ++line._seq;
    var lvEl = line.querySelector('.lv');
    var hadInterim = attempt === 0 ? lvEl.textContent : '';
    var first = true;
    translate(text, ctx, function (partial) {
      if (line._seq !== seq) return;
      // keep the interim text until the final stream has caught up a bit, avoids flicker
      if (first && hadInterim && partial.length < Math.min(hadInterim.length, 12)) return;
      first = false;
      lvEl.textContent = partial; layout();
    }, { timeoutMs: 15000, stallMs: 7000 }).then(function (full) {
      entry.lv = full;
      if (line._seq === seq) lvEl.textContent = full || lvEl.textContent;
      line.classList.remove('waiting');
      clearError(false);
      layout();
    }, function (e) {
      var info = e.info || { msg: String(e.message || e), retry: false, fatal: false };
      log('final fail #' + attempt + ' status=' + e.status + ' ' + info.msg);
      if (info.retry && attempt < 3) {
        showError(info.msg, false);
        setTimeout(function () { translateFinal(line, text, entry, attempt + 1); }, C.retryDelay(attempt));
        return;
      }
      line.classList.remove('waiting');
      showError(info.msg, info.fatal);
      if (!lvEl.textContent) { lvEl.textContent = '[nav iztulkots]'; line.classList.add('error'); }
      layout();
    });
  }

  /* ---------- Speech recognition ---------- */
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
      // Normally onend follows. If it does not within 1.5 s, force a restart.
      setTimeout(function () {
        if (mine() && running && (active || starting)) { log('no onend after error, kick'); kick(); }
      }, 1500);
    };
    r.onend = function () {
      if (!mine()) return;
      active = false; starting = false;
      statusEl.classList.remove('sound');
      log('rec end');
      if (currentLine) finalizeInterimLine();
      if (!running) { updateStatus(); return; }
      var short = Date.now() - sessionStart < 2000 && !gotResult;
      fails = short ? fails + 1 : 0;
      scheduleRestart(C.restartDelay(fails));
    };
    return r;
  }

  /* Throw away the current recognizer (its late events are ignored) and restart. */
  function kick() {
    var old = rec;
    rec = null; gen++;
    active = false; starting = false;
    statusEl.classList.remove('sound');
    if (old) { try { old.abort(); } catch (e) {} }
    if (currentLine) finalizeInterimLine();
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
      if (r.isFinal) handleFinal(t);
      else interimText += t;
    }
    interimText = C.newFinalPart(lastFinalRaw, interimText.trim());
    if (interimText) handleInterim(interimText);
  }

  function handleInterim(text) {
    if (!currentLine) currentLine = createLine();
    currentLine.querySelector('.en').textContent = text;
    currentLine._en = text;
    layout();
    maybeTranslateInterim(currentLine, text);
  }

  function handleFinal(raw) {
    var part = C.newFinalPart(lastFinalRaw, raw);
    lastFinalRaw = raw.trim();
    if (!part) return;
    var line = currentLine || createLine();
    currentLine = null;
    closeInterim(line);
    line.querySelector('.en').textContent = part;
    translateFinal(line, part);
  }

  function finalizeInterimLine() {
    var line = currentLine, text = line._en;
    currentLine = null;
    closeInterim(line);
    if (text) translateFinal(line, text); else line.remove();
    layout();
  }

  function closeInterim(line) {
    line.classList.remove('interim');
    if (interim.ctrl) { try { interim.ctrl.abort(); } catch (e) {} }
    interim.busy = false; interim.ctrl = null;
    interim.lastText = ''; interim.lastAt = 0; interim.pendingText = '';
    clearTimeout(interim.timer);
  }

  function updateStatus() {
    var text, kind;
    if (!SR) { text = 'Nav runas atpazīšanas'; kind = 'err'; }
    else if (!running) { text = lastError && lastError.fatal ? 'Apturēts (kļūda)' : 'Apturēts'; kind = lastError && lastError.fatal ? 'err' : 'off'; }
    else if (document.hidden) { text = 'Fonā, apturēts'; kind = 'warn'; }
    else if (starting) { text = 'Ieslēdz mikrofonu…'; kind = 'warn'; }
    else if (!active) { text = 'Restartē…'; kind = 'warn'; }
    else {
      text = 'Klausās' + (inflight > 0 ? ' · tulko' : '');
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
    if (!SR) {
      showError('Šajā pārlūkā nav runas atpazīšanas. Izmanto Chrome Android ierīcē.', true);
      return;
    }
    if (S.engine === 'openai' && !hasKey()) {
      openSettings();
      $('testResult').textContent = 'Vispirms ielīmē OpenAI API atslēgu.';
      return;
    }
    if (S.engine === 'chrome' && !('Translator' in self)) {
      openSettings();
      $('testResult').textContent = 'Chrome iebūvētais tulkotājs šajā ierīcē nav pieejams. Izvēlies OpenAI.';
      return;
    }
    clearError(false);
    running = true; fails = 0; notAllowedCount = 0;
    log('START');
    document.body.classList.add('running');
    btn.textContent = 'Apturēt'; btn.className = 'big stop';
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
      updateStatus();
    }, 3000);
  }

  function stop() {
    running = false;
    log('STOP');
    clearTimeout(restartTimer); restartTimer = null;
    clearInterval(watchdog);
    if (rec) { try { rec.stop(); } catch (e) {} }
    // if Chrome never sends onend, do not stay "active"
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
  $('size').oninput = function (e) { setSize(+e.target.value); };
  $('toggleEn').onclick = function () { S.showEn = !S.showEn; save(); applyView(); };
  $('toggleTheme').onclick = function () { S.light = !S.light; save(); applyView(); };
  $('toggleMode').onclick = function () { S.mode = S.mode === 'focus' ? 'history' : 'focus'; save(); applyView(); };
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
    $('interim').checked = !!S.interim;
    $('showEn').checked = !!S.showEn;
    $('lightTheme').checked = !!S.light;
    $('lines').value = S.lines; $('linesVal').textContent = S.lines;
    $('testResult').textContent = '';
    $('diag').hidden = true;
    $('chromeNote').textContent = ('Translator' in self)
      ? 'Chrome tulkotājs strādā ierīcē, bez maksas, bet bez konteksta un vājāk.'
      : 'Chrome iebūvētais tulkotājs šajā ierīcē nav pieejams (pagaidām parasti tikai datora Chrome).';
    if (dlg.showModal) dlg.showModal(); else dlg.setAttribute('open', '');
  }
  function readSettings() {
    var keyChanged = S.apiKey !== $('apiKey').value.trim() || S.model !== ($('model').value.trim() || DEFAULTS.model);
    S.engine = $('engine').value;
    S.apiKey = $('apiKey').value.trim();
    S.model = $('model').value.trim() || DEFAULTS.model;
    S.mode = $('mode').value;
    S.interim = $('interim').checked;
    S.showEn = $('showEn').checked;
    S.light = $('lightTheme').checked;
    S.lines = +$('lines').value;
    chromeTranslator = null;
    if (keyChanged) clearError(false); // give a fixed key/model a fresh chance
    save(); applyView();
  }
  $('openSettings').onclick = openSettings;
  $('lines').oninput = function (e) { $('linesVal').textContent = e.target.value; };
  dlg.addEventListener('close', readSettings);
  $('testKey').onclick = function () {
    readSettings();
    var out = $('testResult');
    out.textContent = 'Pārbauda…';
    var t0 = Date.now();
    translate('Good morning everyone, let us start with the quarterly numbers.', [], function (p) {
      out.textContent = p;
    }, { timeoutMs: 15000 }).then(function (full) {
      out.textContent = 'Darbojas (' + ((Date.now() - t0) / 1000).toFixed(1) + ' s): ' + full;
      clearError(false);
    }).catch(function (e) { out.textContent = 'Kļūda: ' + e.message; });
  };
  $('showDiag').onclick = function () {
    var d = $('diag');
    d.hidden = !d.hidden;
    d.textContent = 'running=' + running + ' active=' + active + ' starting=' + starting +
      ' inflight=' + inflight + ' fails=' + fails + ' wakeLock=' + !!wakeLock + '\n' +
      (diag.length ? diag.slice().reverse().join('\n') : '(tukšs)');
  };
  $('saveText').onclick = function () {
    if (!history.length) { $('testResult').textContent = 'Stenogramma ir tukša.'; return; }
    var txt = history.map(function (h) {
      return h.t.toLocaleTimeString('lv-LV') + '\nEN: ' + h.en + '\nLV: ' + (h.lv || '');
    }).join('\n\n');
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([txt], { type: 'text/plain;charset=utf-8' }));
    a.download = 'sapulce-' + new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-') + '.txt';
    document.body.appendChild(a); a.click(); a.remove();
  };
  $('clearText').onclick = function () {
    feed.querySelectorAll('.line').forEach(function (l) { l.remove(); });
    if (currentLine) closeInterim(currentLine);
    currentLine = null;
  };

  /* ---------- Init ---------- */
  applyView();
  updateStatus();
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(function () {});
  }
})();
