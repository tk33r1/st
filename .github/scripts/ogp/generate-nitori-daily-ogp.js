'use strict';

// 互換性ラッパー: generate-daily-ogp.js に統合されました
const { generateDailyOgp } = require('./generate-daily-ogp.js');

if (require.main === module) {
  const targetDate = process.argv[2] || '';
  generateDailyOgp('nitori', targetDate).catch(e => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = {
  generateNitoriDailyOgp: (date) => generateDailyOgp('nitori', date)
};
