#!/usr/bin/env node
// 外部パッケージをインストールせず、固定した版と公開アドバイザリを照合する。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const NPM_DIRS = ['workers', 'magi-app', 'game/reverse-recaptcha', '.github/scripts'];
const RELEASES = 'https://nodejs.org/dist/index.json';
const SCHEDULE = 'https://raw.githubusercontent.com/nodejs/Release/main/schedule.json';
const OSV = 'https://api.osv.dev/v1/';
const readJSON = file => JSON.parse(fs.readFileSync(file, 'utf8'));

function versionParts(value) {
  if (!/^v?\d+\.\d+\.\d+$/.test(value)) throw new Error(`不正な Node.js の版: ${value}`);
  return value.replace(/^v/, '').split('.').map(Number);
}

function compare(a, b) {
  const av = versionParts(a), bv = versionParts(b);
  for (let i = 0; i < 3; i++) if (av[i] !== bv[i]) return av[i] - bv[i];
  return 0;
}

export function nodeFindings(current, releases, schedule, today = new Date().toISOString().slice(0, 10)) {
  const major = versionParts(current)[0];
  const line = schedule[`v${major}`];
  if (!line?.end || !Array.isArray(releases)) throw new Error('Node.js 公式データの形式を確認してください');
  const available = releases.filter(r => r.date <= today && versionParts(r.version)[0] === major);
  if (!available.some(r => compare(r.version, current) === 0)) throw new Error(`公式一覧に Node.js ${current} がありません`);
  available.sort((a, b) => compare(b.version, a.version));
  const findings = [];
  const newer = available.filter(r => compare(r.version, current) > 0);
  if (newer.length) {
    const security = newer.some(r => r.security === true);
    findings.push(`${security ? 'セキュリティ更新' : '更新あり'}: Node.js ${current} → ${available[0].version.slice(1)}（同じメジャー版）。[公式リリース](https://nodejs.org/en/blog/release/${available[0].version})`);
  }
  const days = Math.ceil((Date.parse(line.end) - Date.parse(today)) / 86400000);
  if (!Number.isFinite(days)) throw new Error('Node.js のサポート期限が不正です');
  if (days <= 90) findings.push(`Node.js ${major} のサポート${days <= 0 ? 'は終了済み' : '終了まで90日以内'}（${line.end}）。[移行先を確認](https://nodejs.org/en/about/previous-releases)`);
  return findings;
}

export function inventory(root = ROOT) {
  const entries = new Map();
  const add = (ecosystem, name, version, source) => {
    if (!name || typeof version !== 'string' || !version) throw new Error(`版を特定できません: ${source}`);
    const key = JSON.stringify([ecosystem, name, version]);
    if (!entries.has(key)) entries.set(key, { ecosystem, name, version, sources: [] });
    if (!entries.get(key).sources.includes(source)) entries.get(key).sources.push(source);
  };
  for (const dir of NPM_DIRS) {
    const lock = readJSON(path.join(root, dir, 'package-lock.json'));
    if (!lock.packages || lock.lockfileVersion < 2) throw new Error(`未対応の lockfile: ${dir}`);
    for (const [location, pkg] of Object.entries(lock.packages)) {
      if (!location) continue; // アプリ自身は照合しない。
      if (pkg.link) throw new Error(`リンク依存の監視を追加してください: ${dir}/${location}`);
      add('npm', pkg.name || location.split('node_modules/').at(-1), pkg.version, `${dir}/package-lock.json`);
    }
  }
  const vendorFile = 'assets/vendor/SOURCES.json';
  const vendor = readJSON(path.join(root, vendorFile));
  if (!vendor.files || !Object.keys(vendor.files).length) throw new Error('同梱ライブラリの一覧が空です');
  for (const location of [...Object.keys(vendor.files), ...Object.keys(vendor.split || {})]) {
    const match = location.match(/^((?:@[^/]+\/)?[^/@]+)@([^/]+)\//);
    if (!match) throw new Error(`同梱ライブラリの版を特定できません: ${location}`);
    add('npm', match[1], match[2], vendorFile);
  }
  const readabilityFile = 'magi-app/www/vendor/SOURCES.json';
  const readability = readJSON(path.join(root, readabilityFile));
  add('npm', readability.name, readability.version, readabilityFile);
  const requirementsFile = '.github/scripts/search-reading-requirements.txt';
  const requirements = fs.readFileSync(path.join(root, requirementsFile), 'utf8');
  let count = 0;
  for (const line of requirements.split(/\r?\n/)) {
    if (!line.trim() || /^\s*(#|--hash=)/.test(line)) continue;
    const match = line.match(/^([\w.-]+)==([\w.+-]+)\s*(?:\\)?$/);
    if (!match) throw new Error(`Python依存の書式を確認してください: ${line}`);
    add('PyPI', match[1], match[2], requirementsFile);
    count++;
  }
  if (!count) throw new Error('Python依存の一覧が空です');
  return [...entries.values()].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

export async function requestJSON(url, body) {
  const response = await fetch(url, {
    method: body ? 'POST' : 'GET',
    headers: { 'User-Agent': 'tk.st-dependency-watch', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(45000),
  });
  if (!response.ok) throw new Error(`${new URL(url).host}: HTTP ${response.status}`);
  return response.json();
}

function validateResult(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result) || result.error) throw new Error('OSV の応答が不正です');
  if (result.vulns !== undefined && (!Array.isArray(result.vulns) || result.vulns.some(v => !/^[\w.-]+$/.test(v.id)))) throw new Error('OSV の脆弱性一覧が不正です');
  return result.vulns || [];
}

export async function vulnerabilityFindings(packages, request = requestJSON) {
  const findings = [];
  // バッチ応答の続きも読む。途中の通信失敗を「問題なし」と扱わない。
  for (let offset = 0; offset < packages.length; offset += 100) {
    const batch = packages.slice(offset, offset + 100);
    const queries = batch.map(p => ({ package: { ecosystem: p.ecosystem, name: p.name }, version: p.version }));
    const response = await request(`${OSV}querybatch`, { queries });
    if (!Array.isArray(response.results) || response.results.length !== batch.length) throw new Error('OSV のバッチ結果が不足しています');
    for (let i = 0; i < batch.length; i++) {
      let result = response.results[i];
      const ids = new Set(validateResult(result).filter(v => !v.withdrawn).map(v => v.id));
      const tokens = new Set();
      while (result.next_page_token) {
        if (tokens.has(result.next_page_token)) throw new Error('OSV のページ送りが繰り返されています');
        tokens.add(result.next_page_token);
        result = await request(`${OSV}query`, { ...queries[i], page_token: result.next_page_token });
        for (const vuln of validateResult(result)) if (!vuln.withdrawn) ids.add(vuln.id);
      }
      if (ids.size) {
        const pkg = batch[i];
        const links = [...ids].sort().map(id => `[${id}](https://osv.dev/vulnerability/${id})`).join(', ');
        findings.push(`${pkg.ecosystem}: ${pkg.name}@${pkg.version} — ${links}（${pkg.sources.join(', ')}）`);
      }
    }
  }
  return findings.sort();
}

export async function scan({ root = ROOT, request = requestJSON } = {}) {
  const report = { findings: [], errors: [], checked: [] };
  try {
    const current = fs.readFileSync(path.join(root, '.node-version'), 'utf8').trim();
    const [releases, schedule] = await Promise.all([request(RELEASES), request(SCHEDULE)]);
    report.findings.push(...nodeFindings(current, releases, schedule));
    for (const dir of NPM_DIRS) {
      for (const file of ['package.json', 'package-lock.json']) {
        const pkg = readJSON(path.join(root, dir, file));
        const engines = file === 'package.json' ? pkg.engines : pkg.packages?.['']?.engines;
        if (engines?.node !== `>=${current}`) report.findings.push(`${dir}/${file}: engines.node を .node-version（>=${current}）とそろえてください。`);
      }
    }
    report.checked.push('Node.js: 公式リリース・サポート期限・engines の整合性');
  } catch (error) { report.errors.push(`Node.js: ${error.message}`); }
  try {
    const packages = inventory(root);
    report.findings.push(...await vulnerabilityFindings(packages, request));
    report.checked.push(`OSV: npmの間接依存・同梱ライブラリ・固定Python依存、計${packages.length}組`);
  } catch (error) { report.errors.push(`脆弱性照合: ${error.message}`); }
  report.findings.sort();
  return report;
}

export function markdown(report) {
  return [
    '## 依存関係の定期点検', '',
    ...report.checked.map(x => `- 確認完了: ${x}`), '',
    '### 対応候補', '',
    ...(report.findings.length ? report.findings.map(x => `- ${x}`) : ['今回完了した照合では対応候補なし。']), '',
    '### 検査エラー', '',
    ...(report.errors.length ? report.errors.map(x => `- ${x}`) : ['なし。']), '',
    '検出は更新・影響調査の入口です。該当機能を使うか、修正版、互換性を確認してください。',
    '監視範囲と更新手順: `.github/DEPENDENCIES.md`。',
  ].join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = await scan();
  const body = markdown(report);
  console.log(body);
  if (process.env.DEPENDENCY_REPORT) fs.writeFileSync(process.env.DEPENDENCY_REPORT, JSON.stringify(report, null, 2) + '\n');
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, body + '\n');
  // 発見事項はIssueで管理。検査自体の失敗はActionsも失敗にする。
  if (report.errors.length) process.exitCode = 1;
}
