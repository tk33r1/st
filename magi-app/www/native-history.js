/* Androidの履歴。画面には同期のメモリ窓口を渡し、ファイル操作は順番に確定する。 */
(function (root) {
  'use strict';
  var KEYS = ['magi_saved_sessions', 'magi_current_history', 'magi_current_session_id', 'magi_current_title', 'magi_current_language', 'magi_current_shared'];
  var imageName = /^[a-f0-9]{64}\.(?:jpg|png|gif|webp|heic|heif|avif)$/;
  var sessionId = /^[a-zA-Z0-9_-]{1,160}$/;
  function parse(raw, fallback) { return raw == null ? fallback : JSON.parse(raw); }
  function create(options) {
    var fs = options.fs, legacy = options.legacy, clean = options.cleanHistory;
    // 保存した会話は物のまま持つ。画面は中身を書き換えず、変えた会話は新しい物で置き換える。
    // 会話ごとの保存用の文字列は物に紐付けて使い回し、変わった会話だけを作り直す。
    var state = {}, saved = [], entries = new WeakMap(), active = false, tail = Promise.resolve(), lastError = null;
    var committed = {}, collected = null, pendingImages = new Set(), draftImages = new Set(), queued = false, suspended = false;
    function persistentSessions(list) { return list.filter(function (session) { return session && session.mode !== 'temporary'; }); }
    function owns(key) { return KEYS.indexOf(key) >= 0; }
    function clearLegacyHistory() { KEYS.forEach(function (key) { legacy.removeItem(key); }); }
    function args(path) { return { path: 'magi/' + path, directory: 'DATA' }; }
    async function exists(path) {
      // statの権限・I/Oエラーを「ファイル無し」と扱わない。
      try { await fs.stat(args(path)); return true; }
      catch (e) { if (e.code === 'OS-PLUG-FILE-0008' || e.code === 'ENOENT') return false; throw e; }
    }
    async function read(path) { return JSON.parse((await fs.readFile(Object.assign(args(path), { encoding: 'utf8' }))).data); }
    async function atomicRaw(path, data, encoding) {
      var temp = path + '.tmp';
      await fs.writeFile(Object.assign(args(temp), { data: data, recursive: true }, encoding ? { encoding: encoding } : {}));
      await fs.rename({ from: 'magi/' + temp, to: 'magi/' + path, directory: 'DATA', toDirectory: 'DATA' });
    }
    async function remove(path) { if (await exists(path)) await fs.deleteFile(args(path)); }
    function imagesIn(value, out) {
      if (!value || typeof value !== 'object') return out;
      if (imageName.test(value.file)) out.push(value.file);
      Object.keys(value).forEach(function (key) { imagesIn(value[key], out); });
      return out;
    }
    function entry(session) {
      var e = entries.get(session);
      if (e) return e;
      if (!session || !sessionId.test(session.id)) throw new Error('invalid_session_id');
      var item = Object.assign({}, session, { history: clean(session.history) });
      var row = Object.assign({}, item); delete row.history; delete row.shared;
      e = { path: 'sessions/' + session.id + '.json', text: JSON.stringify(item), row: row, images: imagesIn(item, []) };
      entries.set(session, e);
      return e;
    }
    function documents() {
      var texts = {}, index = [], used = new Set();
      saved.forEach(function (session) {
        var e = entry(session);
        texts[e.path] = e.text; index.push(e.row);
        e.images.forEach(function (name) { used.add(name); });
      });
      texts['index.json'] = JSON.stringify(index);
      var current = {
        id: state.magi_current_session_id || null, title: state.magi_current_title || '',
        language: parse(state.magi_current_language, null), history: clean(parse(state.magi_current_history, [])),
        shared: parse(state.magi_current_shared, null)
      };
      texts['current.json'] = JSON.stringify(current);
      imagesIn(current, []).forEach(function (name) { used.add(name); });
      return { texts: texts, used: used };
    }
    async function apply(texts) {
      for (var path of Object.keys(texts)) {
        var session = /^sessions\/(.+)\.json$/.exec(path);
        if (!/^(?:index|current)\.json$/.test(path) && !(session && sessionId.test(session[1]))) throw new Error('invalid_journal');
        await atomicRaw(path, texts[path], 'utf8');
      }
    }
    async function save() {
      var docs = documents(), changes = {};
      var paths = Object.keys(docs.texts).filter(function (path) { return docs.texts[path] !== committed[path]; });
      paths.forEach(function (path) { changes[path] = docs.texts[path]; });
      if (paths.length) {
        // 複数ファイルの途中で止まったら、次の起動でjournalを再適用する。
        await atomicRaw('pending.json', '{' + paths.map(function (path) { return JSON.stringify(path) + ':' + changes[path]; }).join(',') + '}', 'utf8');
        await apply(changes);
        await remove('pending.json');
      }
      committed = docs.texts;
      await collect(docs);
      return docs;
    }
    async function files(path) { return (await exists(path)) ? (await fs.readdir(args(path))).files : []; }
    async function collect(docs) {
      docs.used.forEach(function (name) { pendingImages.delete(name); });
      var used = new Set(docs.used);
      pendingImages.forEach(function (name) { used.add(name); });
      draftImages.forEach(function (name) { used.add(name); });
      // 会話と画像の顔ぶれが前回の片付けと同じなら、ディレクトリを読まない。
      var signature = Object.keys(docs.texts).sort().join('\n') + '\n\n' + Array.from(used).sort().join('\n');
      if (signature === collected) return;
      for (var file of await files('sessions')) {
        if (file.type === 'file' && docs.texts['sessions/' + file.name] == null) await remove('sessions/' + file.name);
      }
      for (var img of await files('images')) {
        if (img.type === 'file' && !used.has(img.name) && !used.has(img.name.replace(/\.tmp$/, ''))) await remove('images/' + img.name);
      }
      collected = signature;
    }
    // ファイルを触る処理は1列に並べる（保存の片付けが、書きかけの画像や全削除と重ならない）。
    function run(task) {
      var result = tail.then(task);
      tail = result.catch(function () {});
      return result;
    }
    async function persist() {
      try { await save(); lastError = null; }
      catch (e) {
        // 途中まで書けたファイルやjournalが残るため、次回は最新の全項目を書き直す。
        committed = {}; collected = null; lastError = e; if (options.onError) options.onError(e);
      }
    }
    function enqueue() {
      // 題名・会話ID・履歴など、同じ同期処理内の更新を1回にまとめる。
      if (queued) return;
      queued = true;
      tail = tail.then(async function () {
        queued = false;
        try { await save(); lastError = null; }
        catch (e) {
          // 途中まで書けたファイルやjournalが残るため、次回は最新の全項目を書き直して片付ける。
          committed = {}; collected = null; lastError = e; if (options.onError) options.onError(e);
        }
      });
    }
    async function load() {
      if (await exists('pending.json')) {
        var journal = await read('pending.json'), texts = {};
        Object.keys(journal).forEach(function (path) { texts[path] = JSON.stringify(journal[path]); });
        await apply(texts); await remove('pending.json');
      }
      var index = await read('index.json'), current = await read('current.json');
      if (!Array.isArray(index)) throw new Error('invalid_index');
      index.forEach(function (row) { if (!sessionId.test(row.id)) throw new Error('invalid_session_id'); });
      saved = await Promise.all(index.map(async function (row) {
        var session = await read('sessions/' + row.id + '.json');
        if (session.id !== row.id) throw new Error('session_mismatch');
        session.history = clean(session.history);
        return session;
      }));
      state.magi_current_history = JSON.stringify(clean(current.history));
      if (current.id) state.magi_current_session_id = current.id;
      if (current.title) state.magi_current_title = current.title;
      if (current.language) state.magi_current_language = JSON.stringify(current.language);
      if (current.shared) state.magi_current_shared = JSON.stringify(current.shared);
      committed = documents().texts;
    }
    function legacyData() {
      var result = {}, sessions;
      KEYS.forEach(function (key) { var value = legacy.getItem(key); if (value !== null && key !== 'magi_saved_sessions') result[key] = value; });
      try { sessions = parse(legacy.getItem('magi_saved_sessions'), []); } catch (_) { sessions = []; }
      if (!Array.isArray(sessions)) sessions = [];
      try { result.magi_current_history = JSON.stringify(clean(parse(result.magi_current_history, []))); }
      catch (_) { result.magi_current_history = '[]'; }
      try { parse(result.magi_current_language, null); } catch (_) { delete result.magi_current_language; }
      return { state: result, saved: sessions.filter(function (s) { return s && sessionId.test(s.id); }).map(function (s) {
        return Object.assign({}, s, { history: clean(s.history) });
      }) };
    }
    return {
      owns: owns,
      get active() { return active; },
      async init() {
        if (await exists('meta.json')) {
          if ((await read('meta.json')).version !== 1) throw new Error('unsupported_history_version');
          await load(); active = true;
          // 完了の印を書いた直後に終了しても、残った旧項目は次回片付ける。
          clearLegacyHistory();
          return true;
        }
        var data = legacyData();
        try {
          state = data.state; saved = data.saved;
          // 書いた全ファイルの項目と本文を照合してから、完了の印を確定する。
          var docs = await save();
          for (var path of Object.keys(docs.texts)) {
            if (JSON.stringify(await read(path)) !== docs.texts[path]) throw new Error('migration_mismatch');
          }
          await atomicRaw('meta.json', JSON.stringify({ version: 1, migrated: true }), 'utf8');
        } catch (e) { state = {}; saved = []; if (options.onError) options.onError(e); return false; }
        active = true;
        clearLegacyHistory();
        return true;
      },
      // magi_saved_sessions を文字列で読み書きする経路も残す（全会話を変換し直すので、画面は sessions/setSessions を使う）。
      get(key) {
        if (key === 'magi_saved_sessions') return JSON.stringify(saved);
        return state[key] == null ? null : state[key];
      },
      set(key, value) {
        if (suspended) return;
        if (key === 'magi_saved_sessions') saved = persistentSessions(parse(value, [])); else state[key] = value;
        enqueue();
      },
      remove(key) {
        if (suspended) return;
        if (key === 'magi_saved_sessions') { if (!saved.length) return; saved = []; }
        else { if (state[key] == null) return; delete state[key]; }
        enqueue();
      },
      sessions() { return saved.slice(); },
      setSessions(list) { if (suspended) return; saved = persistentSessions(list); enqueue(); },
      suspendWrites() { suspended = true; },
      resumeWrites() { suspended = false; },
      // 再送待ちの画像は、古い保存バッチの参照整理から独立して保持する。
      retainImage(name) { if (imageName.test(name)) draftImages.add(name); },
      releaseImage(name) {
        // 古い保存の片付けが済むまで下書きの参照を残し、最新の正本で整理する。
        tail = tail.then(async function () { pendingImages.delete(name); draftImages.delete(name); await persist(); });
      },
      async flush() { await tail; if (lastError) throw lastError; },
      async storeImage(file) {
        if (suspended) throw new Error('temporary_image_persistence_forbidden');
        var bytes = await file.arrayBuffer();
        var hash = Array.from(new Uint8Array(await root.crypto.subtle.digest('SHA-256', bytes))).map(function (n) { return n.toString(16).padStart(2, '0'); }).join('');
        var ext = ({ 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'image/heic': 'heic', 'image/heif': 'heif', 'image/avif': 'avif' })[file.type] || 'jpg';
        var name = hash + '.' + ext;
        // 使用中の印と書き込みは保存と同じ列で行う。間に保存が入っても、片付けが書いた画像を消さない。
        await run(async function () {
          pendingImages.add(name);
          if (await exists('images/' + name)) return;
          var data = await new Promise(function (resolve, reject) {
            var fr = new FileReader(); fr.onerror = reject; fr.onload = function () { resolve(fr.result.slice(fr.result.indexOf(',') + 1)); }; fr.readAsDataURL(file);
          });
          await atomicRaw('images/' + name, data);
        });
        return name;
      },
      async imageUri(name) {
        if (!imageName.test(name)) throw new Error('invalid_image');
        return (await fs.getUri(args('images/' + name))).uri;
      },
      async usage() {
        await this.flush();
        async function size(path) {
          var total = 0;
          for (var file of await files(path)) total += file.type === 'directory' ? await size(path ? path + '/' + file.name : file.name) : file.size;
          return total;
        }
        return size('');
      },
      async clear() {
        await run(async function () {
          state = { magi_current_history: '[]' }; saved = []; committed = {}; collected = null; pendingImages.clear(); draftImages.clear();
          // metaは残す。空の履歴を確定してから、会話ファイルと画像をcollectで削除する。
          await save(); lastError = null;
        });
        clearLegacyHistory();
      },
      async exportData() {
        await this.flush();
        // サムネも画像本体なので、JSONから除く。画像があった位置だけ文字で残す。
        function withoutImages(value) {
          if (Array.isArray(value)) return value.map(withoutImages);
          if (!value || typeof value !== 'object') return value;
          if (value.type === 'image_url') return { type: 'text', text: '[Image omitted]' };
          var result = {};
          Object.keys(value).forEach(function (key) { if (key !== 'file') result[key] = withoutImages(value[key]); });
          return result;
        }
        return { version: 1, exportedAt: new Date().toISOString(), sessions: withoutImages(saved), current: withoutImages(await read('current.json')) };
      }
    };
  }
  root.MagiNativeHistory = { create: create };
})(typeof window === 'undefined' ? globalThis : window);
