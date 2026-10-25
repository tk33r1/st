// 同じ指摘では通知を重ねず、変化があったときだけIssueを更新する。
module.exports = async ({ github, context, core }) => {
  const fs = require('node:fs');
  const { createHash } = require('node:crypto');
  const { pathToFileURL } = require('node:url');
  const { markdown } = await import(pathToFileURL(require('node:path').join(__dirname, 'dependency-watch.mjs')).href);
  const marker = '<!-- tk-st-dependency-watch -->';
  const report = fs.existsSync(process.env.DEPENDENCY_REPORT)
    ? JSON.parse(fs.readFileSync(process.env.DEPENDENCY_REPORT, 'utf8'))
    : { findings: [], checked: [], errors: ['監視レポートがありません。Actionsのログを確認してください。'] };
  const title = '依存関係の更新・脆弱性の確認';
  const digest = createHash('sha256').update(JSON.stringify(report)).digest('hex');
  const fingerprint = `<!-- fingerprint:${digest} -->`;
  const issues = await github.paginate(github.rest.issues.listForRepo, { ...context.repo, state: 'open', per_page: 100 });
  const issue = issues.find(i => !i.pull_request && i.user?.login === 'github-actions[bot]' && i.body?.includes(marker));
  const actionable = report.findings.length || report.errors.length;
  if (!actionable) {
    if (issue) {
      await github.rest.issues.createComment({ ...context.repo, issue_number: issue.number, body: '今回の全監視が完了し、対応候補と検査エラーがなくなりました。' });
      await github.rest.issues.update({ ...context.repo, issue_number: issue.number, state: 'closed', state_reason: 'completed' });
    }
    return;
  }
  if (issue?.body?.includes(fingerprint)) {
    core.info('指摘に変化なし。通知を省略しました。');
    return;
  }
  const run = `${context.serverUrl}/${context.repo.owner}/${context.repo.repo}/actions/runs/${context.runId}`;
  // GitHubのIssue本文の上限内に収め、全件はartifactに残す。
  const body = `${marker}\n${fingerprint}\n${markdown(report).slice(0, 55000)}\n\n[実行ログ・全件のartifact](${run})`;
  if (issue) {
    await github.rest.issues.update({ ...context.repo, issue_number: issue.number, title, body });
    await github.rest.issues.createComment({ ...context.repo, issue_number: issue.number, body: `検出内容が変わりました。Issue本文を更新しました。\n\n[実行ログ](${run})\n${fingerprint}` });
  } else {
    await github.rest.issues.create({ ...context.repo, title, body });
  }
};
