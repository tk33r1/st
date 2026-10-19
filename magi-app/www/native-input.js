/* B2: 共有と音声入力。呼出し側がAndroidだけでcreateする。 */
(function (root) {
  'use strict';
  function cut(text, n) { return String(text || '').slice(0, n).replace(/[\uD800-\uDBFF]$/, ''); }
  function publicUrl(value) {
    try {
      var url = new URL(value), host = url.hostname.toLowerCase().replace(/\.$/, '');
      if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.href.length > 2000 || host === 'localhost' || host.endsWith('.localhost')) return null;
      function private4(ip) {
        var a = ip.split('.').map(Number);
        return a[0] === 0 || a[0] === 10 || a[0] === 127 || a[0] === 169 && a[1] === 254 || a[0] === 172 && a[1] >= 16 && a[1] <= 31 || a[0] === 192 && a[1] === 168 || a[0] >= 224;
      }
      if (/^\d+\.\d+\.\d+\.\d+$/.test(host) && private4(host)) return null;
      if (host.startsWith('[')) {
        var halves = host.slice(1, -1).split('::'), left = halves[0] ? halves[0].split(':') : [], right = halves[1] ? halves[1].split(':') : [];
        var words = halves.length === 2 ? left.concat(Array(8 - left.length - right.length).fill('0'), right) : left;
        var a = words.map(function (w) { return parseInt(w, 16); });
        if (a.length !== 8 || a.slice(0, 7).every(function (n) { return n === 0; }) && a[7] <= 1
          || (a[0] & 0xfe00) === 0xfc00 || (a[0] & 0xffc0) === 0xfe80 || (a[0] & 0xffc0) === 0xfec0 || (a[0] & 0xff00) === 0xff00) return null;
        if (a.slice(0, 5).every(function (n) { return n === 0; }) && a[5] === 0xffff
          && private4([a[6] >> 8, a[6] & 255, a[7] >> 8, a[7] & 255].join('.'))) return null;
      }
      return url.href;
    } catch (_) { return null; }
  }
  function decodePage(result) {
    var bytes = Uint8Array.from(atob(result.base64), function (ch) { return ch.charCodeAt(0); });
    if (bytes.byteLength > 2 * 1024 * 1024) throw new Error('article_too_large');
    var header = /charset\s*=\s*["']?([^\s;"']+)/i.exec(result.contentType || '');
    var prefix = new TextDecoder('windows-1252').decode(bytes.slice(0, 4096));
    var meta = /<meta\b[^>]*charset\s*=\s*["']?\s*([^\s;"'/>]+)/i.exec(prefix);
    var label = (header || meta || [null, 'utf-8'])[1];
    try { return new TextDecoder(label).decode(bytes); } catch (_) { return new TextDecoder('utf-8').decode(bytes); }
  }
  function article(result) {
    if (!publicUrl(result.url) || !/^(text\/html|application\/xhtml\+xml)(;|$)/i.test(result.contentType || '')) throw new Error('invalid_article');
    // template内は不活性。画像・iframeなどを取り除いてから、閲覧コンテキストの無い文書で抜き出す。
    var template = document.createElement('template'); template.innerHTML = decodePage(result);
    template.content.querySelectorAll('script,style,iframe,frame,img,video,audio,source,link,object,embed').forEach(function (el) { el.remove(); });
    var doc = document.implementation.createHTMLDocument('');
    doc.body.replaceChildren(template.content.cloneNode(true));
    var title = template.content.querySelector('title') || doc.body.querySelector('h1');
    var sourceTitle = title ? title.textContent.trim() : '';
    if (sourceTitle) doc.title = sourceTitle;
    var parsed = new root.Readability(doc, { charThreshold: 0, maxElemsToParse: 20000 }).parse();
    if (!parsed || !parsed.textContent || !parsed.textContent.trim()) throw new Error('empty_article');
    return { title: cut(parsed.title || sourceTitle || result.url, 200), url: result.url, text: cut(parsed.textContent.trim(), 6000) };
  }
  function create(options) {
    var cap = options.cap, bridge = cap.Plugins.MagiShare, speech = cap.Plugins.SpeechRecognition;
    var draining = false, drainAgain = false, stopped = false, listeners = [], voiceGeneration = 0, recognitionId = 0, recording = false, starting = false, retried = false, language = '', voiceTimer = null;
    var permissionNotice = 'Microphone permission is required. You can enable it in Android Settings. / マイクの許可が必要です（設定から許可できます）。';
    async function receive(payload) {
      options.beginShare();
      var token = options.generation(), text = String(payload.text || ''), shared = null;
      var urls = text.match(/https?:\/\/[^\s<>"']+/gi) || [];
      if (text.length > 1000) shared = { title: 'Shared text / 共有された文章', url: '', text: cut(text, 6000) };
      options.setDraft(text.length <= 1000 ? text : '');
      if (shared) options.setShared(shared);
      try {
        if (urls.length === 1) {
          var url = publicUrl(urls[0]);
          if (!url) options.notice('Could not read the article (only the URL will be sent). / 本文を読めませんでした（URLだけ送ります）。');
          else {
            try {
              var result = await bridge.getArticle({ url: url });
              if (token !== options.generation()) return;
              options.setShared(article(result));
            } catch (_) { if (token === options.generation()) options.notice('Could not read the article (only the URL will be sent). / 本文を読めませんでした（URLだけ送ります）。'); }
          }
        }
        if (token !== options.generation()) return;
        var files = [];
        for (var image of (payload.images || []).slice(0, 4)) {
          var res = await fetch(cap.convertFileSrc(image.path));
          if (!res.ok) throw new Error('shared_image_unavailable');
          files.push(new File([await res.blob()], 'shared-image', { type: image.type }));
        }
        if (token !== options.generation()) return;
        if (files.length) await options.attach(files);
        if (payload.truncated) options.notice('Added the first 4 images only. / 最初の4枚だけ入れました。');
        else if (payload.imageError) options.notice('Some images could not be read. / 一部の画像を読めませんでした。');
      } finally {
        await bridge.releaseShare({ paths: (payload.images || []).map(function (img) { return img.path; }) }).catch(function () {});
        if (options.endShare) options.endShare(token);
      }
    }
    async function drain() {
      if (stopped) return;
      if (draining) { drainAgain = true; return; }
      draining = true;
      try {
        do {
          drainAgain = false;
          while (!stopped) {
            var next = await bridge.takeShare(); if (!next.share) break;
            await receive(next.share).catch(function () { options.notice('Could not read shared data. / 共有された内容を読めませんでした。'); });
          }
        } while (drainAgain && !stopped);
      } finally { draining = false; }
    }
    function endVoice() {
      recording = false; starting = false; clearTimeout(voiceTimer); voiceTimer = null;
      options.voiceState(false); options.interim('');
    }
    async function stopVoice() {
      voiceGeneration++;
      var wasRecording = recording;
      endVoice();
      if (speech && wasRecording) await speech.stop().catch(function () {});
    }
    async function listen() {
      var token = voiceGeneration;
      await speech.start({ language: language, maxResults: 1, partialResults: true, popup: false, sessionId: String(++recognitionId) });
      if (token === voiceGeneration && recording) voiceTimer = setTimeout(function () { stopVoice(); options.notice('Voice input timed out. / 音声入力を終了しました。'); }, 60000);
    }
    function useEnglish() {
      language = 'en-US'; retried = true;
      options.notice('This language is unavailable. Using English. / この言語には対応していないため英語で認識します。');
    }
    async function startVoice() {
      if (!speech || recording || starting) { if (recording) await speech.stop(); return; }
      starting = true; var token = ++voiceGeneration;
      try {
        if (!(await speech.available()).available) throw new Error('voice_unavailable');
        var permission = await speech.checkPermissions();
        if (token !== voiceGeneration) return;
        if (permission.speechRecognition !== 'granted') {
          options.notice('Voice input uses your device speech service. / 音声入力には端末の音声認識を使います。');
          permission = await speech.requestPermissions();
        }
        if (token !== voiceGeneration) return;
        if (permission.speechRecognition !== 'granted') { options.notice(permissionNotice); return; }
        language = navigator.language || 'en-US'; retried = false;
        var languagesTimer;
        try {
          var supported = (await Promise.race([speech.getSupportedLanguages(), new Promise(function (_, reject) {
            languagesTimer = setTimeout(function () { reject(new Error('language_list_unavailable')); }, 1500);
          })])).languages;
          if (Array.isArray(supported) && supported.length && !supported.some(function (s) { return s.toLowerCase() === language.toLowerCase() || s.toLowerCase() === language.split('-')[0].toLowerCase(); })) {
            useEnglish();
          }
        } catch (_) { /* Android 13以降は認識時の言語エラーで判定する */ }
        finally { clearTimeout(languagesTimer); }
        if (token !== voiceGeneration) return;
        recording = true; options.voiceState(true); await listen();
      } catch (_) { if (token === voiceGeneration) { options.notice('Could not start voice input. / 音声入力を開始できませんでした。'); endVoice(); } }
      finally { if (token === voiceGeneration) starting = false; }
    }
    return {
      receive: receive, startVoice: startVoice, stopVoice: stopVoice,
      async init() {
        if (bridge) { listeners.push(await bridge.addListener('shareAvailable', drain)); await drain(); }
        if (speech) {
          listeners.push(await speech.addListener('partialResults', function (event) {
            if (!recording || event.sessionId !== String(recognitionId)) return;
            var text = event.matches && event.matches[0] || '';
            if (event.final) { options.appendDraft(text); endVoice(); }
            else options.interim(text);
          }));
          listeners.push(await speech.addListener('recognitionError', async function (event) {
            if (!recording || event.sessionId !== String(recognitionId)) return;
            if ((event.code === 12 || event.code === 13) && !retried && !/^en\b/i.test(language)) {
              clearTimeout(voiceTimer); useEnglish();
              var token = voiceGeneration;
              try { await listen(); } catch (_) { if (token === voiceGeneration) endVoice(); } return;
            }
            endVoice(); options.notice(event.code === 9 ? permissionNotice : 'Voice input ended without a result. / 音声を認識できませんでした。');
          }));
        }
      },
      async destroy() { stopped = true; await stopVoice(); await Promise.all(listeners.map(function (l) { return l.remove(); })); }
    };
  }
  root.MagiNativeInput = { create: create, publicUrl: publicUrl, decodePage: decodePage, article: article };
})(typeof window === 'undefined' ? globalThis : window);
