#!/usr/bin/env node

import { syncKimiModels, resolveKimiConfigPath } from '../lib/index.js';

async function main() {
  console.log('\n🔄 [kimi-model-sync] Initializing Kimi Code model synchronization...');

  const configPath = resolveKimiConfigPath();
  console.log(`📂 Configuration target: ${configPath}`);

  try {
    const report = await syncKimiModels({ configPath });

    if (report.results.length === 0) {
      console.log('ℹ️  No custom providers with base_url found in config.toml.');
      process.exit(0);
    }

    console.log('\n📊 Synchronization Report:');
    console.log('------------------------------------------------------------');
    console.log(' Provider            | Added | Updated | Total | Status');
    console.log('------------------------------------------------------------');

    let hasErrors = false;
    for (const r of report.results) {
      const pName = r.providerId.padEnd(19).slice(0, 19);
      const added = String(r.added).padStart(5);
      const updated = String(r.updated).padStart(7);
      const total = String(r.total).padStart(5);
      const status = r.error ? `❌ ${r.error.slice(0, 25)}` : '✅ Success';
      if (r.error) hasErrors = true;

      console.log(` ${pName} | ${added} | ${updated} | ${total} | ${status}`);
    }
    console.log('------------------------------------------------------------');

    if (hasErrors) {
      console.log('\n⚠️  Some providers experienced synchronization errors. Check logs above.');
      process.exit(1);
    } else {
      console.log('\n✨ All custom provider models synchronized successfully with models.dev!');
      console.log('💡 Restart Kimi Code CLI or run `/reload` to apply updated models.\n');
      process.exit(0);
    }
  } catch (err) {
    console.error(`\n❌ Fatal Error: ${err.message}\n`);
    process.exit(1);
  }
}

main();
