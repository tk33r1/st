// 端末データに触れず、I/O失敗とクラッシュ時のファイルを再現する。
export function nativeFilesystemFixture() {
  const files = new Map(), operations = [];
  let fail = null;
  const missing = () => Object.assign(new Error('missing'), { code: 'OS-PLUG-FILE-0008' });
  const key = o => (o.directory || 'DATA') + ':' + o.path.replace(/\/$/, '');
  function check(method, path) {
    operations.push([method, path]);
    if (fail && fail(method, path)) throw new Error('simulated I/O failure');
  }
  function children(prefix) { return [...files.keys()].filter(k => k.startsWith(prefix + '/')); }
  const fs = {
    async stat(o) { check('stat', o.path); const k = key(o); if (files.has(k)) return { type: 'file', size: files.get(k).length }; if (children(k).length) return { type: 'directory', size: 0 }; throw missing(); },
    async readFile(o) { check('read', o.path); if (!files.has(key(o))) throw missing(); return { data: files.get(key(o)) }; },
    async writeFile(o) { check('write', o.path); files.set(key(o), o.data); return { uri: 'file:///' + o.path }; },
    async rename(o) { check('rename', o.to); const from = key({ path: o.from, directory: o.directory }), to = key({ path: o.to, directory: o.toDirectory }); if (!files.has(from)) throw missing(); files.set(to, files.get(from)); files.delete(from); },
    async deleteFile(o) { check('delete', o.path); if (!files.delete(key(o))) throw missing(); },
    async readdir(o) {
      check('readdir', o.path);
      const prefix = key(o), names = new Map();
      for (const k of children(prefix)) {
        const rest = k.slice(prefix.length + 1), name = rest.split('/')[0];
        names.set(name, { name, type: rest.includes('/') ? 'directory' : 'file', size: files.get(k).length });
      }
      return { files: [...names.values()] };
    },
    async rmdir(o) { check('rmdir', o.path); for (const k of children(key(o))) files.delete(k); },
    async getUri(o) { return { uri: 'file:///' + o.path }; }
  };
  return { fs, files, operations, setFailure(fn) { fail = fn; } };
}
