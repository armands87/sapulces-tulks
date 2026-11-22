/* Sapulces tulks: live EN -> LV translation. Plain JS, no build step. */
(function () {
  'use strict';
  var C = window.TCore;
  var $ = function (id) { return document.getElementById(id); };

  /* ---------- Settings (localStorage only) ---------- */
  var DEFAULTS = {
    apiKey: '', model: 'gpt-4.1-mini', engine: 'openai', interim: true,
    showEn: false, light: false, size: 44, lines: 7
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

  /* ---------- Elements ---------- */
  var feed = $('feed'), statusEl = $('status'), btn = $('startStop'), dlg = $('settings');

  function applyView() {
    document.documentElement.style.setProperty('--size', S.size + 'px');
    $('size').value = S.size;
    document.body.classList.toggle('light', !!S.light);
    document.body.classList.toggle('show-en', !!S.showEn);
    $('toggleEn').classList.toggle('on', !!S.showEn);
    document.querySelector('meta[name=theme-color]').content = S.light ? '#ffffff' : '#000000';
    layout();
  }

  function setStatus(text, kind) {
    statusEl.textContent = text;
    statusEl.className = 'status ' + (kind || 'off');
  }

  /* ---------- Feed rendering ---------- */
  var history = [];      // finished lines {en, lv, t}
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
    var n = S.lines, total = lines.length;
    for (var i = 0; i < total; i++) {
      var fromEnd = total - 1 - i; // 0 = newest
      if (fromEnd >= n + 20) { lines[i].remove(); continue; }
      var el = lines[i];
      if (fromEnd >= n) { el.style.display = 'none'; continue; }
      el.style.display = '';
      var fadeZone = Math.min(3, Math.max(1, n - 3));
      var posFromOldest = n - 1 - fromEnd; // 0 = oldest visible
      el.style.opacity = posFromOldest < fadeZone ? String(0.25 + 0.6 * posFromOldest / fadeZone) : '1';
    }
    feed.scrollTop = feed.scrollHeight;
  }

  /* ---------- Translation ---------- */
  var chromeTranslator = null;

  function hasKey() { return S.apiKey && S.apiKey.trim().length > 20; }

  function translate(text, context, onDelta, signal) {
    if (S.engine === 'chrome') return translateChrome(text, onDelta);
    return translateOpenAI(text, context, onDelta, signal);
  }

  function translateOpenAI(text, context, onDelta, signal) {
    if (!hasKey()) return Promise.reject(new Error('Nav OpenAI atslēgas (⚙)'));
    return fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + S.apiKey.trim() },
      body: JSON.stringify(C.buildBody(S.model || DEFAULTS.model, text, context, true)),
      signal: signal
    }).then(function (res) {
      if (!res.ok) {
        return res.text().then(function (t) {
          var msg = 'OpenAI kļūda ' + res.status;
          if (res.status === 401) msg = 'Nederīga OpenAI atslēga';
          else if (res.status === 429) msg = 'OpenAI limits vai nav kredīta (429)';
          else if (res.status === 404) msg = 'Modelis nav pieejams: ' + S.model;
          var err = new Error(msg); err.status = res.status; err.detail = t; throw err;
        });
      }
      var reader = res.body.getReader();
      var dec = new TextDecoder();
      var parser = new C.SSEParser();
      var full = '';
      function pump() {
        return reader.read().then(function (r) {
          if (r.done) return full;
          var deltas = parser.push(dec.decode(r.value, { stream: true }));
          for (var i = 0; i < deltas.length; i++) { full += deltas[i]; onDelta(full); }
          return pump();
        });
      }
      return pump();
    });
  }

  function translateChrome(text, onDelta) {
    var get = chromeTranslator ? Promise.resolve(chromeTranslator) :
      self.Translator.create({ sourceLanguage: 'en', targetLanguage: 'lv' }).then(function (t) {
        chromeTranslator = t; return t;
      });
    return get.then(function (t) { return t.translate(text); }).then(function (out) { onDelta(out); return out; });
  }

  function contextFor() {
    return history.slice(-3).map(function (h) { return h.en; });
  }

  /* Interim translation: one request at a time per line, throttled. */
  var interim = { busy: false, lastText: '', lastAt: 0, ctrl: null, timer: null, pendingText: '' };
  var INTERIM_GAP = 1200;

  function maybeTranslateInterim(line, text) {
    interim.pendingText = text;
    if (!S.interim || interim.busy) return;
    if (S.engine === 'openai' && !hasKey()) return;
    var now = Date.now();
    if (!C.shouldTranslateInterim(text, interim.lastText, interim.lastAt, now, INTERIM_GAP)) {
      clearTimeout(interim.timer);
      interim.timer = setTimeout(function () {
        if (currentLine === line && interim.pendingText) maybeTranslateInterim(line, interim.pendingText);
      }, Math.max(150, INTERIM_GAP - (now - interim.lastAt)));
      return;
    }
    interim.busy = true;
    interim.lastText = text;
    interim.lastAt = now;
    var seq = ++line._seq;
    var ctrl = window.AbortController ? new AbortController() : null;
    interim.ctrl = ctrl;
    translate(text, contextFor(), function (partial) {
      if (line._seq === seq && line.classList.contains('interim')) {
        line.querySelector('.lv').textContent = partial; layout();
      }
    }, ctrl && ctrl.signal).catch(function (e) {
      if (e.name !== 'AbortError') handleApiError(e);
    }).then(function () {
      if (interim.ctrl === ctrl) { interim.busy = false; interim.ctrl = null; }
    });
  }

  function translateFinal(line, text, attempt) {
    attempt = attempt || 0;
    var ctx = contextFor();
    var entry = { en: text, lv: '', t: new Date() };
    history.push(entry);
    line.classList.add('waiting');
    var seq = ++line._seq;
    var lvEl = line.querySelector('.lv');
    var hadInterim = lvEl.textContent;
    var first = true;
    translate(text, ctx, function (partial) {
      if (line._seq !== seq) return;
      // keep the interim text until the final stream has caught up a bit, avoids flicker
      if (first && hadInterim && partial.length < Math.min(hadInterim.length, 12)) return;
      first = false;
      lvEl.textContent = partial; layout();
    }).then(function (full) {
      entry.lv = full;
      if (line._seq === seq) lvEl.textContent = full;
      line.classList.remove('waiting');
      if (statusEl.classList.contains('err') && running) setStatus('Klausās', 'on');
      layout();
    }).catch(function (e) {
      line.classList.remove('waiting');
      if (attempt < 1 && !e.status) { history.pop(); return translateFinal(line, text, attempt + 1); }
      handleApiError(e);
      if (!lvEl.textContent) { lvEl.textContent = '[' + e.message + ']'; line.classList.add('error'); }
      layout();
    });
  }

  function handleApiError(e) {
    setStatus(e.message || 'Tulkošanas kļūda', 'err');
  }

  /* ---------- Speech recognition ---------- */
  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  var rec = null, running = false, recActive = false, restartTimer = null;
  var fails = 0, sessionStart = 0, lastEventAt = 0, lastFinalRaw = '', gotResult = false;
  var wakeLock = null, watchdog = null;

  function makeRec() {
    var r = new SR();
    r.lang = 'en-US';
    r.continuous = true;
    r.interimResults = true;
    r.maxAlternatives = 1;
    r.onstart = function () {
      recActive = true; sessionStart = Date.now(); lastEventAt = Date.now();
      gotResult = false; lastFinalRaw = '';
      setStatus('Klausās', 'on');
    };
    r.onresult = onResult;
    r.onerror = function (ev) {
      lastEventAt = Date.now();
      if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') {
        stop();
        setStatus('Nav mikrofona atļaujas', 'err');
        alert('Chrome neļauj izmantot mikrofonu. Atļauj to adreses joslā (slēdzenes ikona) un mēģini vēlreiz.');
        return;
      }
      if (ev.error === 'network') setStatus('Runas atpazīšanai nav interneta', 'warn');
      else if (ev.error === 'audio-capture') setStatus('Mikrofons nav pieejams', 'warn');
      // no-speech, aborted etc.: onend restarts
    };
    r.onend = function () {
      recActive = false;
      // turn a half-finished interim line into a final one
      if (currentLine) finalizeInterimLine();
      if (!running) return;
      var short = Date.now() - sessionStart < 2000 && !gotResult;
      fails = short ? fails + 1 : 0;
      scheduleRestart(C.restartDelay(fails));
    };
    return r;
  }

  function scheduleRestart(delay) {
    clearTimeout(restartTimer);
    if (fails > 2) setStatus('Restartē…', 'warn');
    restartTimer = setTimeout(startRec, delay);
  }

  function startRec() {
    restartTimer = null;
    if (!running || recActive || document.hidden) return;
    try {
      if (!rec) rec = makeRec();
      rec.start();
    } catch (e) {
      // InvalidStateError: already started, or stuck. Recreate the object.
      try { rec.abort(); } catch (e2) {}
      rec = makeRec();
      fails++;
      scheduleRestart(C.restartDelay(fails));
    }
  }

  function onResult(e) {
    lastEventAt = Date.now();
    gotResult = true;
    fails = 0;
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
  }

  function closeInterim(line) {
    line.classList.remove('interim');
    if (interim.ctrl) { try { interim.ctrl.abort(); } catch (e) {} }
    interim.busy = false; interim.lastText = ''; interim.lastAt = 0; interim.pendingText = '';
    clearTimeout(interim.timer);
  }

  /* ---------- Wake lock ---------- */
  function lockScreen() {
    if (!('wakeLock' in navigator) || !running) return;
    navigator.wakeLock.request('screen').then(function (l) { wakeLock = l; }).catch(function () {});
  }
  function unlockScreen() {
    if (wakeLock) { try { wakeLock.release(); } catch (e) {} wakeLock = null; }
  }
  document.addEventListener('visibilitychange', function () {
    if (document.hidden || !running) return;
    lockScreen();
    if (!recActive) scheduleRestart(200);
  });

  /* ---------- Start / stop ---------- */
  function start() {
    if (!SR) {
      alert('Šajā pārlūkā nav runas atpazīšanas. Izmanto Chrome Android ierīcē.');
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
    running = true; fails = 0;
    document.body.classList.add('running');
    btn.textContent = 'Apturēt'; btn.className = 'big stop';
    lockScreen();
    startRec();
    clearInterval(watchdog);
    watchdog = setInterval(function () {
      if (!running || document.hidden) return;
      // stuck: not active and no restart pending
      if (!recActive && !restartTimer) startRec();
      // silent hang: active but no events for 60 s
      if (recActive && Date.now() - lastEventAt > 60000) { lastEventAt = Date.now(); try { rec.abort(); } catch (e) {} }
    }, 5000);
  }

  function stop() {
    running = false;
    clearTimeout(restartTimer); restartTimer = null;
    clearInterval(watchdog);
    if (rec) { try { rec.stop(); } catch (e) {} }
    unlockScreen();
    document.body.classList.remove('running');
    btn.textContent = 'Sākt'; btn.className = 'big start';
    setStatus('Apturēts', 'off');
  }

  btn.addEventListener('click', function () { running ? stop() : start(); });

  /* ---------- Toolbar ---------- */
  function setSize(v) { S.size = Math.max(20, Math.min(96, v)); save(); applyView(); }
  $('smaller').onclick = function () { setSize(S.size - 4); };
  $('bigger').onclick = function () { setSize(S.size + 4); };
  $('size').oninput = function (e) { setSize(+e.target.value); };
  $('toggleEn').onclick = function () { S.showEn = !S.showEn; save(); applyView(); };
  $('toggleTheme').onclick = function () { S.light = !S.light; save(); applyView(); };
  $('fullscreen').onclick = function () {
    if (document.fullscreenElement) document.exitFullscreen();
    else if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(function () {});
  };

  /* ---------- Settings dialog ---------- */
  function openSettings() {
    $('engine').value = S.engine;
    $('apiKey').value = S.apiKey;
    $('model').value = S.model;
    $('interim').checked = !!S.interim;
    $('showEn').checked = !!S.showEn;
    $('lightTheme').checked = !!S.light;
    $('lines').value = S.lines; $('linesVal').textContent = S.lines;
    $('testResult').textContent = '';
    $('chromeNote').textContent = ('Translator' in self)
      ? 'Chrome tulkotājs strādā ierīcē, bez maksas, bet tulko vārds pa vārdam bez konteksta.'
      : 'Chrome iebūvētais tulkotājs šajā ierīcē nav pieejams (pagaidām parasti tikai datora Chrome).';
    if (dlg.showModal) dlg.showModal(); else dlg.setAttribute('open', '');
  }
  function readSettings() {
    S.engine = $('engine').value;
    S.apiKey = $('apiKey').value.trim();
    S.model = $('model').value.trim() || DEFAULTS.model;
    S.interim = $('interim').checked;
    S.showEn = $('showEn').checked;
    S.light = $('lightTheme').checked;
    S.lines = +$('lines').value;
    chromeTranslator = null;
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
    }).then(function (full) {
      out.textContent = 'Darbojas (' + ((Date.now() - t0) / 1000).toFixed(1) + ' s): ' + full;
    }).catch(function (e) { out.textContent = 'Kļūda: ' + e.message; });
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
    currentLine = null;
  };

  /* ---------- Init ---------- */
  applyView();
  setStatus(SR ? 'Gaida' : 'Nav runas atpazīšanas', SR ? 'off' : 'err');
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(function () {});
  }
})();
