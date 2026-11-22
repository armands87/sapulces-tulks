/* Pure logic, no DOM. Loaded by the page and by test/run-tests.js (jsc). */
(function (root) {
  'use strict';

  var SYSTEM_PROMPT =
    'You are a live interpreter at a business meeting. Translate the English speech fragment ' +
    'into natural, spoken Latvian, the way a skilled Latvian interpreter would say it out loud. ' +
    'Rules: output ONLY the Latvian translation, no quotes, no comments, no English. ' +
    'Keep personal names, company and product names, code, numbers and well-known technical ' +
    'terms as they are (add a Latvian form only if it is common). ' +
    'The input comes from speech recognition: it has no punctuation and may contain recognition ' +
    'errors or cut-off words; silently fix obvious errors using context and add punctuation. ' +
    'If the fragment is incomplete, translate what is there without inventing the rest. ' +
    'Use short, clear sentences. Never use em dashes.';

  /* Build chat messages: previous sentences as context, only the new fragment to translate. */
  function buildMessages(text, context) {
    var ctx = (context || []).filter(Boolean).slice(-3);
    var user = '';
    if (ctx.length) {
      user += 'Previous sentences (context only, do NOT translate):\n' + ctx.join('\n') + '\n\n';
    }
    user += 'Translate into Latvian:\n' + text;
    return [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: user }
    ];
  }

  /* Request body for /v1/chat/completions. Reasoning models (gpt-5*, o*) get minimal reasoning. */
  function buildBody(model, text, context, stream) {
    var body = {
      model: model,
      messages: buildMessages(text, context),
      stream: !!stream,
      max_completion_tokens: 300
    };
    if (/^(gpt-5|o\d)/i.test(model)) {
      body.reasoning_effort = 'minimal';
    } else {
      body.temperature = 0.2;
    }
    return body;
  }

  /*
   * Live captions: the speech is translated in short fragments (clauses), each
   * appended to the screen and never rewritten. Tiny prompt for low latency.
   */
  var CHUNK_PROMPT =
    'You are a simultaneous interpreter, English to Latvian, at a business meeting. ' +
    'The English comes from AUTOMATIC SPEECH RECOGNITION: no punctuation, and some words are ' +
    'misheard (homophones like write/right, split or merged words like "write size" for "rightsize", ' +
    'mangled names and jargon). Using the earlier conversation and the glossary, infer what the ' +
    'speaker actually meant and translate THAT meaning into natural, logical Latvian. Never translate ' +
    'an obviously misheard word literally; if a word makes no sense and you cannot infer it, leave it out. ' +
    'You also get the Latvian you have already said. Output ONLY the Latvian for the new fragment, ' +
    'continuing your Latvian naturally: no repetition of earlier text, no quotes, no comments. ' +
    'Lowercase unless a new sentence starts. Keep names, companies, products, numbers and technical ' +
    'terms (glossary spelling wins). Never use em dashes.';

  function glossaryLine(glossary) {
    var g = (glossary || '').replace(/\s+/g, ' ').trim().slice(0, 600);
    return g ? '\nMeeting topic and glossary (names, terms, acronyms; misheard words are often these): ' + g : '';
  }

  function buildChunkMessages(fragment, prevEn, prevLv, endsSentence, glossary) {
    var user = '';
    if (prevEn) user += 'Earlier English: ' + prevEn + '\n';
    if (prevLv) user += 'Your Latvian so far: ' + prevLv + '\n';
    user += 'New fragment' + (endsSentence ? ' (ends the sentence)' : '') + ': ' + fragment;
    return [
      { role: 'system', content: CHUNK_PROMPT + glossaryLine(glossary) },
      { role: 'user', content: user }
    ];
  }

  /* v7: ~10 sentences of context each way (500 chars) so the model can infer misheard words. */
  var CONTEXT_CHARS = 500;

  function buildChunkBody(model, fragment, prevEn, prevLv, endsSentence, glossary) {
    var body = {
      model: model,
      messages: buildChunkMessages(fragment, tail(prevEn, CONTEXT_CHARS), tail(prevLv, CONTEXT_CHARS), endsSentence, glossary),
      stream: true,
      max_completion_tokens: 120
    };
    if (/^(gpt-5|o\d)/i.test(model)) body.reasoning_effort = 'minimal';
    else body.temperature = 0.2;
    return body;
  }

  /* Last ~n characters, cut at a word boundary. */
  function tail(s, n) {
    s = (s || '').trim();
    if (s.length <= n) return s;
    var t = s.slice(-n);
    var sp = t.indexOf(' ');
    return sp >= 0 ? t.slice(sp + 1) : t;
  }

  /* Chunk size presets: minWords before a commit, words held back (recognizer may still
   * change the newest words), pause that commits everything, hard maximum. */
  var CHUNK_PRESETS = {
    short:    { minWords: 3, holdBack: 1, pauseMs: 450, maxWords: 8 },   // v7: was 4 / 600 ms
    v6short:  { minWords: 4, holdBack: 1, pauseMs: 600, maxWords: 8 },   // v6 baseline, for comparison tests
    medium:   { minWords: 7, holdBack: 2, pauseMs: 700, maxWords: 12 },
    sentence: { minWords: 1e9, holdBack: 0, pauseMs: 900, maxWords: 1e9 }
  };

  var BOUNDARY = { and: 1, but: 1, so: 1, because: 1, which: 1, that: 1, then: 1, or: 1, when: 1,
    if: 1, while: 1, where: 1, who: 1, although: 1, since: 1, unless: 1, until: 1, after: 1, before: 1 };

  /*
   * Decide how many new words to commit (translate) now.
   * words: current utterance words; committed: already translated count.
   * event: 'interim' | 'pause' | 'final'. Returns a count (0 = wait).
   */
  function planChunk(words, committed, event, p) {
    var remaining = words.length - committed;
    if (remaining <= 0) return 0;
    if (event === 'final' || event === 'pause') return remaining;
    var avail = remaining - p.holdBack;
    if (avail < p.minWords) return 0;
    // never more than maxWords in one fragment: a burst of words becomes several
    // small fragments that are translated in parallel and shown in order
    var lim = Math.min(avail, p.maxWords);
    return cutAtBoundary(words, committed, lim, p) || lim;
  }

  /* Prefer to end a chunk right before a conjunction ("... the budget | and then ..."). */
  function cutAtBoundary(words, committed, avail, p) {
    for (var n = avail; n >= Math.min(3, p.minWords); n--) {
      var next = (words[committed + n] || '').toLowerCase().replace(/[^a-z']/g, '');
      if (BOUNDARY[next]) return n;
    }
    return 0;
  }

  /*
   * Reading-paced reveal (v4). Translated words go into a queue and are shown one by
   * one at a steady pace. The pace rises smoothly only when the backlog grows, up to a
   * cap, so a burst of text never lands on screen at once.
   * base/max: words per second. Latvian speech rate is ~2 w/s, so "normal" keeps up.
   */
  var REVEAL_PRESETS = {
    slow:   { base: 2.5, max: 5.5 },
    normal: { base: 3.5, max: 7 },
    fast:   { base: 4.5, max: 9 }
  };

  /*
   * v7 elastic pacing: with a small queue (1 to 3 words), follow the rate at which translated
   * words actually arrive (incoming, words/s) instead of the fixed base rate. The last
   * buffered word is stretched a little, so the next phrase usually arrives before the
   * screen runs dry: a steady flow instead of "burst, pause, burst".
   * incoming 0 or unknown = old behaviour.
   */
  var MIN_FLOW = 1.6;
  function revealRate(backlog, presetName, incoming) {
    var p = REVEAL_PRESETS[presetName] || REVEAL_PRESETS.normal;
    if (incoming > 0 && backlog >= 1 && backlog <= 3) {
      var k = backlog === 1 ? 0.8 : backlog === 2 ? 1.0 : 1.15;
      return Math.max(MIN_FLOW, Math.min(p.base, incoming * k));
    }
    var extra = backlog > 4 ? (backlog - 4) * 0.35 : 0;
    return Math.min(p.max, p.base + extra);
  }

  /* Delay (ms) before the next word. A short breath after a sentence end when not behind. */
  function revealDelay(backlog, presetName, lastWord, incoming) {
    var d = 1000 / revealRate(backlog, presetName, incoming);
    if (backlog < 4 && /[.!?]["')]*$/.test(lastWord || '')) d += 250;
    return Math.round(d);
  }

  /* Words of a (possibly still streaming) translation that are complete enough to show. */
  function availableWords(text, done) {
    var t = text || '';
    var w = t.split(/\s+/).filter(Boolean);
    if (!done && w.length && !/\s$/.test(t)) w.pop(); // last token may be half a word
    return w;
  }

  /* ---------- Context correction (v7) ----------
   * A second, silent pass: once a few more words have been spoken, a phrase already on
   * screen is re-checked with what came before AND after it. The screen is only changed
   * when the corrected Latvian differs meaningfully. */
  var CORRECT_PROMPT =
    'You are the editor of live English to Latvian meeting subtitles. The English comes from ' +
    'automatic speech recognition and contains misheard words (homophones, split or merged words, ' +
    'mangled names and jargon); the Latvian TARGET was translated in a hurry from a short fragment. ' +
    'Using the conversation before and after it, the glossary and any recognition alternatives, ' +
    'decide what the speaker really meant and give the best natural, logical Latvian for the TARGET ' +
    'part only (do not include the before/after text). Remove or fix words that make no sense. ' +
    'Keep it as close to the existing Latvian as possible: change only what is wrong or illogical. ' +
    'Never use em dashes. Answer with JSON only: {"lv": "<Latvian for TARGET>", "reason": "<few words, English>"}.';

  function buildCorrectionBody(model, o) {
    var user =
      (o.beforeEn ? 'BEFORE (English): ' + tail(o.beforeEn, 600) + '\n' : '') +
      (o.beforeLv ? 'BEFORE (Latvian, already shown): ' + tail(o.beforeLv, 600) + '\n' : '') +
      'TARGET (English, as recognised): ' + o.targetEn + '\n' +
      (o.alts && o.alts.length ? 'Recognition alternatives for this sentence: ' + o.alts.join(' | ') + '\n' : '') +
      'TARGET (Latvian, shown now): ' + o.targetLv + '\n' +
      (o.afterEn ? 'AFTER (English, spoken next): ' + o.afterEn.slice(0, 400) + '\n' : '');
    var body = {
      model: model,
      messages: [
        { role: 'system', content: CORRECT_PROMPT + glossaryLine(o.glossary) },
        { role: 'user', content: user }
      ],
      response_format: { type: 'json_object' },
      max_completion_tokens: 300
    };
    if (/^(gpt-5|o\d)/i.test(model)) body.reasoning_effort = 'minimal';
    else body.temperature = 0;
    return body;
  }

  /* Accepts the JSON answer (or a bare string); returns the Latvian or '' if unusable. */
  function parseCorrection(text) {
    var t = (text || '').trim();
    if (!t) return '';
    try {
      var j = JSON.parse(t);
      return typeof j.lv === 'string' ? j.lv.trim() : '';
    } catch (e) {
      var m = t.match(/"lv"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      return m ? JSON.parse('"' + m[1] + '"').trim() : '';
    }
  }

  function normWords(s) {
    return (s || '').toLowerCase().replace(/[.,!?;:"'()«»„“”]/g, ' ').split(/\s+/).filter(Boolean);
  }

  /* Word-level edit distance. */
  function wordDistance(a, b) {
    var m = a.length, n = b.length, prev = [], cur, i, j;
    for (j = 0; j <= n; j++) prev[j] = j;
    for (i = 1; i <= m; i++) {
      cur = [i];
      for (j = 1; j <= n; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      prev = cur;
    }
    return prev[n];
  }

  /*
   * Is the correction worth moving text on screen? Not for punctuation, capitalisation or
   * a single tiny word; yes for any changed content word or 2+ changed words.
   */
  function meaningfulChange(oldLv, newLv) {
    var a = normWords(oldLv), b = normWords(newLv);
    if (!b.length) return false;
    var d = wordDistance(a, b);
    if (d === 0) return false;
    if (d >= 2) return true;
    var changed = a.filter(function (w) { return b.indexOf(w) < 0; })
      .concat(b.filter(function (w) { return a.indexOf(w) < 0; }));
    return changed.some(function (w) { return w.length >= 4; });
  }

  /* ---------- Transcript (v5) ----------
   * session = { startedAt: ms epoch, records: [{ t: ms from start, en, lv }] } */
  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function formatOffset(ms) {
    var s = Math.max(0, Math.floor(ms / 1000));
    return pad2(Math.floor(s / 3600)) + ':' + pad2(Math.floor(s / 60) % 60) + ':' + pad2(s % 60);
  }

  function formatDateTime(d) {
    return pad2(d.getDate()) + '.' + pad2(d.getMonth() + 1) + '.' + d.getFullYear() + ' ' +
      pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  function formatDuration(ms) {
    var m = Math.round(ms / 60000);
    if (m < 60) return m + ' min';
    return Math.floor(m / 60) + ' h ' + (m % 60) + ' min';
  }

  function transcriptFilename(startedAt, ext) {
    var d = new Date(startedAt);
    return 'sapulce-' + d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + '-' +
      pad2(d.getHours()) + pad2(d.getMinutes()) + '.' + ext;
  }

  /* Latvian count agreement: 1, 21, 31... take the singular (but 11 does not). */
  function plural(n, one, many) {
    return n + ' ' + (n % 10 === 1 && n % 100 !== 11 ? one : many);
  }

  function capFirst(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

  /* Records that have something to show (empty segments are skipped). */
  function usableRecords(records) {
    return (records || []).filter(function (r) { return (r.lv && r.lv.trim()) || (r.en && r.en.trim()); });
  }

  function transcriptStats(session) {
    var recs = usableRecords(session.records);
    var last = recs.length ? recs[recs.length - 1].t : 0;
    return { count: recs.length, durationMs: last,
      words: recs.reduce(function (a, r) { return a + (r.lv || '').split(/\s+/).filter(Boolean).length; }, 0) };
  }

  function transcriptText(session, withEn) {
    var recs = usableRecords(session.records), st = transcriptStats(session);
    var out = ['Sapulces tulks: sarunas pieraksts',
      'Sākums: ' + formatDateTime(new Date(session.startedAt)),
      'Ilgums: ' + formatDuration(st.durationMs) + ', ' + plural(st.count, 'runas daļa', 'runas daļas'),
      ''];
    recs.forEach(function (r) {
      var lv = capFirst((r.lv || '').trim()) || '[nav iztulkots]';
      if (withEn) {
        out.push('[' + formatOffset(r.t) + ']');
        out.push('LV: ' + lv);
        out.push('EN: ' + (r.en || '').trim());
        out.push('');
      } else {
        out.push('[' + formatOffset(r.t) + '] ' + lv);
      }
    });
    return out.join('\n').replace(/\n+$/, '') + '\n';
  }

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* A self-contained page that reads well on a phone, in light and dark mode. */
  function transcriptHtml(session, withEn) {
    var recs = usableRecords(session.records), st = transcriptStats(session);
    var title = 'Sapulce ' + formatDateTime(new Date(session.startedAt));
    var rows = recs.map(function (r) {
      return '<section><time>' + formatOffset(r.t) + '</time><p class="lv">' +
        escapeHtml(capFirst((r.lv || '').trim()) || '[nav iztulkots]') + '</p>' +
        (r.draft && r.draft !== r.lv ? '<p class="draft">Pirmais variants: ' + escapeHtml(r.draft.trim()) + '</p>' : '') +
        (withEn ? '<p class="en">' + escapeHtml((r.en || '').trim()) + '</p>' : '') + '</section>';
    }).join('\n');
    return '<!doctype html>\n<html lang="lv"><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width, initial-scale=1">' +
      '<title>' + escapeHtml(title) + '</title><style>' +
      ':root{color-scheme:light dark;--fg:#111;--bg:#fff;--dim:#666;--line:#ddd}' +
      '@media (prefers-color-scheme:dark){:root{--fg:#eee;--bg:#000;--dim:#999;--line:#333}}' +
      'body{margin:0;padding:16px;background:var(--bg);color:var(--fg);font:18px/1.5 system-ui,sans-serif;max-width:760px}' +
      'h1{font-size:22px;margin:0 0 4px}.meta{color:var(--dim);margin:0 0 16px}' +
      'section{border-top:1px solid var(--line);padding:10px 0}time{color:var(--dim);font-size:14px}' +
      '.lv{margin:2px 0;font-weight:600}.en{margin:2px 0;color:var(--dim)}.draft{margin:2px 0;color:var(--dim);font-size:14px;text-decoration:line-through}' +
      '</style></head><body>\n<h1>' + escapeHtml(title) + '</h1>\n<p class="meta">Ilgums: ' +
      formatDuration(st.durationMs) + ', ' + plural(st.count, 'runas daļa', 'runas daļas') + '</p>\n' + rows + '\n</body></html>\n';
  }

  function median(arr) {
    if (!arr.length) return 0;
    var a = arr.slice().sort(function (x, y) { return x - y; });
    var m = a.length >> 1;
    return a.length % 2 ? a[m] : Math.round((a[m - 1] + a[m]) / 2);
  }

  /* Incremental SSE parser. Feed text chunks, get content deltas back. */
  function SSEParser() {
    this.buf = '';
    this.done = false;
  }
  SSEParser.prototype.push = function (chunk) {
    this.buf += chunk;
    var out = [];
    var lines = this.buf.split('\n');
    this.buf = lines.pop();
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (line.indexOf('data:') !== 0) continue;
      var data = line.slice(5).trim();
      if (data === '[DONE]') { this.done = true; continue; }
      try {
        var j = JSON.parse(data);
        var d = j.choices && j.choices[0] && j.choices[0].delta;
        if (d && d.content) out.push(d.content);
      } catch (e) { /* partial or non-JSON line, ignore */ }
    }
    return out;
  };

  function normalize(s) {
    return (s || '').toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();
  }
  function words(s) {
    var n = normalize(s);
    return n ? n.split(' ') : [];
  }

  /*
   * Chrome on Android sometimes repeats earlier final text inside a new final result
   * ("hello everyone" then "hello everyone let's start"). Return only the new part,
   * or '' if the result is a pure duplicate.
   */
  function newFinalPart(prevFinal, transcript) {
    var t = (transcript || '').trim();
    if (!t) return '';
    var p = (prevFinal || '').trim();
    if (!p) return t;
    var nt = normalize(t), np = normalize(p);
    if (nt === np) return '';
    if (np && nt.indexOf(np) === 0) {
      var pw = words(p).length;
      var tw = t.split(/\s+/);
      return tw.slice(pw).join(' ').trim();
    }
    return t;
  }

  /* Should we fire an interim translation now? */
  function shouldTranslateInterim(text, lastSentText, lastSentAt, now, minGapMs) {
    var w = words(text).length;
    if (w < 3) return false;
    if (now - lastSentAt < minGapMs) return false;
    var lw = words(lastSentText).length;
    return w - lw >= 2 || (lw && normalize(text).indexOf(normalize(lastSentText)) !== 0 && w >= lw);
  }

  /* Restart delay with backoff for repeated quick failures. */
  function restartDelay(consecutiveFails) {
    var d = 250 * Math.pow(2, Math.max(0, consecutiveFails));
    return Math.min(d, 4000);
  }

  /* Rough cost estimate in USD for one hour. Prices per 1M tokens. */
  function estimateCostPerHour(opts) {
    var req = opts.finalRequests + opts.interimRequests;
    var inTok = req * opts.inputTokensPerReq;
    var outTok = req * opts.outputTokensPerReq;
    return (inTok / 1e6) * opts.priceIn + (outTok / 1e6) * opts.priceOut;
  }

  /*
   * Turn an OpenAI HTTP error into a Latvian message + whether a retry makes sense.
   * status 0 = network error / timeout.
   */
  function classifyError(status, bodyText, model) {
    var code = '';
    try { var j = JSON.parse(bodyText || '{}'); code = (j.error && (j.error.code || j.error.type)) || ''; } catch (e) {}
    if (status === 0) return { msg: 'Nav savienojuma ar OpenAI (internets vai noildze)', retry: true, fatal: false };
    if (status === 401) return { msg: 'Nederīga OpenAI atslēga. Atver ⚙ un ielīmē pareizo.', retry: false, fatal: true };
    if (status === 429 && /insufficient_quota|billing/.test(code + bodyText))
      return { msg: 'OpenAI kontā beidzies kredīts vai sasniegts tēriņu limits.', retry: false, fatal: true };
    if (status === 429) return { msg: 'OpenAI ātruma limits (429), mēģina vēlreiz', retry: true, fatal: false };
    if (status === 404 || code === 'model_not_found')
      return { msg: 'Modelis "' + model + '" nav pieejams. Atver ⚙ un izvēlies citu.', retry: false, fatal: true };
    if (status === 400) return { msg: 'OpenAI noraidīja pieprasījumu (400). Pārbaudi modeli ⚙.', retry: false, fatal: true };
    if (status >= 500) return { msg: 'OpenAI serveru kļūda (' + status + '), mēģina vēlreiz', retry: true, fatal: false };
    return { msg: 'OpenAI kļūda ' + status, retry: false, fatal: false };
  }

  /* Retry delay for translation attempts (ms). */
  function retryDelay(attempt) {
    return [800, 2500, 6000][Math.min(attempt, 2)];
  }

  /*
   * Which lines are visible and how. mode 'focus': only the newest line big,
   * the one before it small and dim. mode 'history': last n lines, older fade,
   * newest marked as current (yellow in CSS).
   * Returns array (oldest first) of {show, opacity, role} where role is
   * 'current' | 'prev' | 'old'.
   */
  function lineStyles(mode, total, n) {
    var out = [];
    for (var i = 0; i < total; i++) {
      var fromEnd = total - 1 - i;
      var role = fromEnd === 0 ? 'current' : (fromEnd === 1 ? 'prev' : 'old');
      if (mode === 'focus') {
        out.push({ show: fromEnd <= 1, opacity: fromEnd === 0 ? 1 : 0.45, role: role });
        continue;
      }
      if (fromEnd >= n) { out.push({ show: false, opacity: 0, role: role }); continue; }
      var fadeZone = Math.min(3, Math.max(1, n - 3));
      var posFromOldest = n - 1 - fromEnd;
      var op = posFromOldest < fadeZone ? 0.25 + 0.6 * posFromOldest / fadeZone : 1;
      out.push({ show: true, opacity: Math.round(op * 100) / 100, role: role });
    }
    return out;
  }

  /*
   * Recognition health check, run by the watchdog every few seconds.
   * Returns 'ok' | 'start' (nothing running, nothing scheduled) | 'kick' (hung).
   */
  function watchdogAction(st, now) {
    if (!st.running || st.hidden) return 'ok';
    if (st.active) {
      // active but silent for too long: Chrome Android sometimes stops delivering events
      return now - st.lastEventAt > st.silentLimitMs ? 'kick' : 'ok';
    }
    if (st.starting && now - st.startCalledAt < 6000) return 'ok'; // waiting for onstart
    if (st.starting) return 'kick'; // start() never produced onstart
    if (st.restartPending && now - st.restartScheduledAt < 8000) return 'ok';
    return 'start';
  }

  root.TCore = {
    CORRECT_PROMPT: CORRECT_PROMPT,
    buildCorrectionBody: buildCorrectionBody,
    parseCorrection: parseCorrection,
    meaningfulChange: meaningfulChange,
    wordDistance: wordDistance,
    plural: plural,
    formatOffset: formatOffset,
    formatDateTime: formatDateTime,
    formatDuration: formatDuration,
    transcriptFilename: transcriptFilename,
    transcriptStats: transcriptStats,
    transcriptText: transcriptText,
    transcriptHtml: transcriptHtml,
    escapeHtml: escapeHtml,
    REVEAL_PRESETS: REVEAL_PRESETS,
    revealRate: revealRate,
    revealDelay: revealDelay,
    availableWords: availableWords,
    CHUNK_PROMPT: CHUNK_PROMPT,
    CHUNK_PRESETS: CHUNK_PRESETS,
    buildChunkMessages: buildChunkMessages,
    buildChunkBody: buildChunkBody,
    planChunk: planChunk,
    tail: tail,
    median: median,
    classifyError: classifyError,
    retryDelay: retryDelay,
    lineStyles: lineStyles,
    watchdogAction: watchdogAction,
    SYSTEM_PROMPT: SYSTEM_PROMPT,
    buildMessages: buildMessages,
    buildBody: buildBody,
    SSEParser: SSEParser,
    newFinalPart: newFinalPart,
    shouldTranslateInterim: shouldTranslateInterim,
    restartDelay: restartDelay,
    estimateCostPerHour: estimateCostPerHour,
    words: words
  };
})(typeof self !== 'undefined' ? self : this);
