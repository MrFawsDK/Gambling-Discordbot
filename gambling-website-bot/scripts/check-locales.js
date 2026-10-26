import { config } from '../src/config.js';
import { loadLocale, validateLocale } from './validateLocales.js';

const problems = validateLocale(loadLocale(config.localesDir));
if (problems.length > 0) {
  console.error(`Found ${problems.length} locale problem(s):`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log('da.json looks fine.');
