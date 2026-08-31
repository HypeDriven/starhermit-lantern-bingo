'use strict';
// Standalone content validator runner (npm run validate).
import { validateAll } from '../js/content.js';

const report = validateAll();
let failed = 0;
for (const r of report) {
  if (!r.ok) { failed++; console.error('FAIL', r.errors.join('; ')); }
}
console.log(`Validated ${report.length} content items, ${failed} failures.`);
process.exit(failed ? 1 : 0);
