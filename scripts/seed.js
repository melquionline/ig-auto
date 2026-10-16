// Sincroniza as automações de ./automations com o banco (cria ou atualiza pelo nome).
// Uso: node scripts/seed.js [username]   (padrão: todas as contas conectadas)
import { readdirSync } from 'node:fs';
import { accounts, automations } from '../src/db.js';
import { validateAutomation } from '../src/engine/validate.js';

const force = process.argv.includes('--force');
const only = process.argv.slice(2).find((a) => !a.startsWith('--'));
const dir = new URL('../automations/', import.meta.url);
const defs = await Promise.all(readdirSync(dir).filter((f) => f.endsWith('.js'))
  .map(async (f) => (await import(new URL(f, dir))).default));

const targets = accounts.list().filter((a) => !only || a.username === only);
if (!targets.length) { console.error('Nenhuma conta conectada' + (only ? ` com @${only}` : '')); process.exit(1); }

for (const acc of targets) {
  for (const def of defs) {
    const errs = validateAutomation(def);
    if (errs.length) throw new Error(`${def.name}:\n  - ${errs.join('\n  - ')}`);
    if (!force && automations.exists(acc.ig_user_id, def.name)) {
      console.log(`@${acc.username}: "${def.name}" já existe — mantida como está no painel (use --force para sobrescrever)`);
      continue;
    }
    const id = automations.upsertByName({ accountId: acc.ig_user_id, ...def });
    console.log(`@${acc.username}: "${def.name}" → automação #${id}`);
  }
}
