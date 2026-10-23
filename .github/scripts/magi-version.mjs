// npm の版 X.Y.Z を画面の X.Y / X.YZ に直す。末尾の0を省き、5.90等を作らない。
export function magiDisplayVersion(packageVersion) {
  const match = typeof packageVersion === 'string' && /^(\d{1,2})\.(\d)\.(\d)$/.exec(packageVersion);
  if (!match) throw new Error('invalid_magi_package_version');
  return match[1] + '.' + match[2] + (match[3] === '0' ? '' : match[3]);
}
