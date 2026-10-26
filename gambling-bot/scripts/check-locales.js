import { validateLocales } from '../src/i18n.js';

const problems = validateLocales();
if (problems.length > 0) {
  console.error(`Found ${problems.length} locale problem(s):`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log('Locales are in sync.');
