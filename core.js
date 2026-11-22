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

  root.TCore = {
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
