import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
import path from 'node:path';

const root=process.argv[2];
assert.ok(root,'Supply the extracted resources/app directory.');
const entry=path.join(root,'desktop-windows/local-ai/smoke.mjs');
assert.ok(existsSync(entry),'Packaged smoke entrypoint is missing.');
const source=readFileSync(entry,'utf8');
const imports=[...source.matchAll(/^\s*import\s+(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/gm)].map(match=>match[1]);
assert.ok(imports.length>0,'Packaged smoke entrypoint has no static imports.');
for(const specifier of imports){
  if(specifier.startsWith('node:')||specifier==='electron')continue;
  assert.ok(specifier.startsWith('.'),`Unexpected non-bundled smoke import: ${specifier}`);
  const target=path.resolve(path.dirname(entry),specifier);
  assert.ok(existsSync(target),`Packaged smoke import is missing: ${specifier}`);
  process.stdout.write(`PACKAGE_SMOKE_IMPORT_OK ${specifier}\n`);
}
assert.ok(imports.includes('../src/smoke-timeout.mjs'),'Smoke timeout helper must be included in the extracted test package.');
assert.match(source,/REEL_WHISPER_SMOKE_STARTUP_ONLY/u,'Smoke entrypoint must support a bounded startup-only mode.');
assert.match(source,/log\('smoke_start'\)/u,'Smoke must write its first phase before loading model assets.');
process.stdout.write('PACKAGE_LOCAL_AI_SMOKE_PREFLIGHT_OK\n');
