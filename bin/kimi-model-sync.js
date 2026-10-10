#!/usr/bin/env node

import { syncKimiModels, resolveKimiConfigPath } from '../lib/index.js';

async function main() {
  const args = process.argv.slice(2);
  const isDryRun = args.includes('--dry-run') || args.includes('-n') || args.includes('--preview');

  console.log('\n🔄 [kimi-model-sync] Initializing Kimi Code model synchronization...');
  if (isDryRun) {
    console.log('🔍 Running in [DRY RUN / PREVIEW] mode. No files will be modified.');
  }

  const configPath = resolveKimiConfigPath();
  console.log(`📂 Configuration target: ${configPath}`);

  try {
    const report = await syncKimiModels({ configPath, dryRun: isDryRun });

    if (report.results.length === 0) {
      console.log(`ℹ️  ${report.message || 'No eligible custom providers found in config.toml.'}`);
      process.exit(0);
    }

    console.log('\n📊 Synchronization Report:');
    console.log('--------------------------------------------------------------------------------');
    console.log(' Provider            | Endpoint URL                 | Added | Updated | Total');
    console.log('--------------------------------------------------------------------------------');

    let hasErrors = false;
    for (const r of report.results) {
      const pName = r.providerId.padEnd(19).slice(0, 19);
      const urlDisp = (r.matchedUrl || r.baseUrl || '').padEnd(28).slice(0, 28);
      const added = String(r.added).padStart(5);
      const updated = String(r.updated).padStart(7);
      const total = String(r.total).padStart(5);

      console.log(` ${pName} | ${urlDisp} | ${added} | ${updated} | ${total}`);
      if (r.error) {
        hasErrors = true;
        console.log(`   └─ ❌ Error: ${r.error}`);
      }
    }
    console.log('--------------------------------------------------------------------------------');

    if (report.diffSummary && report.diffSummary.length > 0) {
      console.log('\n📝 Diff & Changes Preview:');
      for (const diff of report.diffSummary.slice(0, 30)) {
        const icon = diff.action === 'add' ? '➕' : '🔄';
        console.log(` ${icon} [${diff.action.toUpperCase()}] ${diff.model}: ${diff.details}`);
      }
      if (report.diffSummary.length > 30) {
        console.log(` ... and ${report.diffSummary.length - 30} more model changes.`);
      }
    }

    if (isDryRun) {
      console.log('\n💡 [DRY RUN] Preview complete. Re-run without --dry-run to apply these changes to config.toml.\n');
      process.exit(0);
    }

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
