/* Androidの履歴。画面には同期のメモリ窓口を渡し、ファイル操作は順番に確定する。 */
(function (root) {
  'use strict';
  var KEYS = ['magi_saved_sessions', 'magi_current_history', 'magi_current_session_id', 'magi_current_title', 'magi_current_language', 'magi_current_shared'];
  var imageName = /^[a-f0-9]{64}\.(?:jpg|png|gif|webp|heic|heif|avif)$/;
  var sessionId = /^[a-zA-Z0-9_-]{1,160}$/;
  function parse(raw, fallback) { return raw == null ? fallback : JSON.parse(raw); }
  function create(options) {
    var fs = options.fs, legacy = options.legacy, clean = options.cleanHistory;
    var state = {}, active = false, tail = Promise.resolve(), lastError = null, committed = {}, pendingImages = new Set(), queued = false;
    function owns(key) { return KEYS.indexOf(key) >= 0; }
    function clearLegacyHistory() { KEYS.forEach(function (key) { legacy.removeItem(key); }); }
    function args(path) { return { path: 'magi/' + path, directory: 'DATA' }; }
    async function exists(path) {
      // statの権限・I/Oエラーを「ファイル無し」と扱わない。
      try { await fs.stat(args(path)); return true; }
      catch (e) { if (e.code === 'OS-PLUG-FILE-0008' || e.code === 'ENOENT') return false; throw e; }
    }
    async function read(path) { return JSON.parse((await fs.readFile(Object.assign(args(path), { encoding: 'utf8' }))).data); }
    async function atomic(path, value) {
      var temp = path + '.tmp';
      await fs.writeFile(Object.assign(args(temp), { data: JSON.stringify(value), encoding: 'utf8', recursive: true }));
      await fs.rename({ from: 'magi/' + temp, to: 'magi/' + path, directory: 'DATA', toDirectory: 'DATA' });
    }
    async function remove(path) { if (await exists(path)) await fs.deleteFile(args(path)); }
    function snapshot() {
      var result = {};
      KEYS.forEach(function (key) { if (state[key] != null) result[key] = state[key]; });
      return result;
    }
    function documents(data) {
      var sessions = parse(data.magi_saved_sessions, []), docs = {}, index = [];
      sessions.forEach(function (s) {
        if (!sessionId.test(s.id)) throw new Error('invalid_session_id');
        var item = Object.assign({}, s, { history: clean(s.history) });
        docs['sessions/' + s.id + '.json'] = item;
        var row = Object.assign({}, item); delete row.history; delete row.shared; index.push(row);
      });
      docs['index.json'] = index;
      docs['current.json'] = {
        id: data.magi_current_session_id || null, title: data.magi_current_title || '',
        language: parse(data.magi_current_language, null), history: clean(parse(data.magi_current_history, [])),
        shared: parse(data.magi_current_shared, null)
      };
      return docs;
    }
    async function apply(docs) {
      for (var path of Object.keys(docs)) {
        if (!/^(?:index|current)\.json$/.test(path) && !/^sessions\/[a-zA-Z0-9_-]{1,160}\.json$/.test(path)) throw new Error('invalid_journal');
        await atomic(path, docs[path]);
      }
    }
    async function save(data) {
      var docs = documents(data), serialized = {}, changes = {};
      Object.keys(docs).forEach(function (path) {
        serialized[path] = JSON.stringify(docs[path]);
        if (serialized[path] !== committed[path]) changes[path] = docs[path];
      });
      if (Object.keys(changes).length) {
        // 複数ファイルの途中で止まったら、次の起動でjournalを再適用する。
        await atomic('pending.json', changes);
        await apply(changes);
        await remove('pending.json');
      }
      committed = serialized;
      await collect(docs);
    }
    async function files(path) { return (await exists(path)) ? (await fs.readdir(args(path))).files : []; }
    async function collect(docs) {
      var used = new Set(pendingImages);
      function walk(value) {
        if (!value || typeof value !== 'object') return;
        if (imageName.test(value.file)) { used.add(value.file); pendingImages.delete(value.file); }
        Object.keys(value).forEach(function (key) { walk(value[key]); });
      }
      Object.values(docs).forEach(walk);
      for (var file of await files('sessions')) {
        if (file.type === 'file' && !docs['sessions/' + file.name]) await remove('sessions/' + file.name);
      }
      for (var img of await files('images')) {
        if (img.type === 'file' && !used.has(img.name) && !used.has(img.name.replace(/\.tmp$/, ''))) await remove('images/' + img.name);
      }
    }
    function enqueue() {
      // 題名・会話ID・履歴など、同じ同期処理内の更新を1回にまとめる。
      if (queued) return;
      queued = true;
      tail = tail.then(async function () {
        queued = false;
        try { await save(snapshot()); lastError = null; }
        catch (e) {
          // 途中まで書けたファイルやjournalが残るため、次回は最新の全項目を書き直す。
          committed = {}; lastError = e; if (options.onError) options.onError(e);
        }
      });
    }
    async function load() {
      if (await exists('pending.json')) { await apply(await read('pending.json')); await remove('pending.json'); }
      var index = await read('index.json'), current = await read('current.json'), sessions = [];
      if (!Array.isArray(index)) throw new Error('invalid_index');
      for (var row of index) {
        if (!sessionId.test(row.id)) throw new Error('invalid_session_id');
        var session = await read('sessions/' + row.id + '.json');
        if (session.id !== row.id) throw new Error('session_mismatch');
        session.history = clean(session.history); sessions.push(session);
      }
      state.magi_saved_sessions = JSON.stringify(sessions);
      state.magi_current_history = JSON.stringify(clean(current.history));
      if (current.id) state.magi_current_session_id = current.id;
      if (current.title) state.magi_current_title = current.title;
      if (current.language) state.magi_current_language = JSON.stringify(current.language);
      if (current.shared) state.magi_current_shared = JSON.stringify(current.shared);
      var docs = documents(snapshot());
      Object.keys(docs).forEach(function (path) { committed[path] = JSON.stringify(docs[path]); });
    }
    function legacyData() {
      var result = {}, sessions;
      KEYS.forEach(function (key) { var value = legacy.getItem(key); if (value !== null) result[key] = value; });
      try { sessions = parse(result.magi_saved_sessions, []); } catch (_) { sessions = []; }
      if (!Array.isArray(sessions)) sessions = [];
      result.magi_saved_sessions = JSON.stringify(sessions.filter(function (s) { return s && sessionId.test(s.id); }).map(function (s) {
        return Object.assign({}, s, { history: clean(s.history) });
      }));
      try { result.magi_current_history = JSON.stringify(clean(parse(result.magi_current_history, []))); }
      catch (_) { result.magi_current_history = '[]'; }
      try { parse(result.magi_current_language, null); } catch (_) { delete result.magi_current_language; }
      return result;
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
          state = data; await save(data);
          // 書いた全ファイルの項目と本文を照合してから、完了の印を確定する。
          var docs = documents(data);
          for (var path of Object.keys(docs)) {
            if (JSON.stringify(await read(path)) !== JSON.stringify(docs[path])) throw new Error('migration_mismatch');
          }
          await atomic('meta.json', { version: 1, migrated: true });
        } catch (e) { state = {}; if (options.onError) options.onError(e); return false; }
        active = true;
        clearLegacyHistory();
        return true;
      },
      get(key) { return state[key] == null ? null : state[key]; },
      set(key, value) { state[key] = value; enqueue(); },
      remove(key) { if (state[key] == null) return; delete state[key]; enqueue(); },
      retainImage(name) { if (imageName.test(name)) pendingImages.add(name); },
      releaseImage(name) { pendingImages.delete(name); enqueue(); },
      async flush() { await tail; if (lastError) throw lastError; },
      async storeImage(file) {
        await tail;
        var bytes = await file.arrayBuffer();
        var hash = Array.from(new Uint8Array(await root.crypto.subtle.digest('SHA-256', bytes))).map(function (n) { return n.toString(16).padStart(2, '0'); }).join('');
        var ext = ({ 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'image/heic': 'heic', 'image/heif': 'heif', 'image/avif': 'avif' })[file.type] || 'jpg';
        var name = hash + '.' + ext;
        pendingImages.add(name);
        if (!(await exists('images/' + name))) {
          var data = await new Promise(function (resolve, reject) {
            var fr = new FileReader(); fr.onerror = reject; fr.onload = function () { resolve(fr.result.split(',')[1]); }; fr.readAsDataURL(file);
          });
          await fs.writeFile(Object.assign(args('images/' + name + '.tmp'), { data: data, recursive: true }));
          await fs.rename({ from: 'magi/images/' + name + '.tmp', to: 'magi/images/' + name, directory: 'DATA', toDirectory: 'DATA' });
        }
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
        await tail;
        state = { magi_saved_sessions: '[]', magi_current_history: '[]' }; committed = {}; pendingImages.clear();
        // metaは残す。空の履歴を確定してから、会話ファイルと画像をcollectで削除する。
        await save(snapshot()); lastError = null;
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
        return { version: 1, exportedAt: new Date().toISOString(), sessions: withoutImages(parse(state.magi_saved_sessions, [])), current: withoutImages(await read('current.json')) };
      }
    };
  }
  root.MagiNativeHistory = { create: create };
})(typeof window === 'undefined' ? globalThis : window);
