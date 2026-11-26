import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import {readFile} from 'node:fs/promises';
import {startAssetServer} from '../src/asset-server.mjs';

test('serves only fixed app assets and rejects mutations, host spoofing and traversal', async t=>{
  const server=await startAssetServer();t.after(()=>server.close());
  for(const asset of ['/','/setup.mjs','/setup.css','/capture/','/capture/renderer.mjs',
    '/web/reel/capture.js','/web/reel/core.js','/web/reel/whisper-languages.js?v=20261126-language','/web/reel/audio.js?v=1','/web/reel/encoder-worker.js',
    '/web/reel/fmp4.js','/web/vendor/mp4-muxer.mjs']) {
    const result=await fetch(server.origin+asset);
    assert.equal(result.status,200,asset);assert.ok((await result.text()).length>0,asset);
    assert.equal(result.headers.get('cache-control'),'no-store');
    assert.match(result.headers.get('content-security-policy'),/frame-ancestors 'none'/);
  }
  for(const asset of ['/config.json','/preload.cjs','/src/auth.mjs','/../VERSION','/%2e%2e/VERSION'])
    assert.equal((await fetch(server.origin+asset)).status,404,asset);
  assert.equal((await fetch(server.origin+'/',{method:'POST',body:'no'})).status,405);
  const status=await new Promise((resolve,reject)=>{
    http.get(server.origin+'/',{headers:{Host:'attacker.example'}},response=>{response.resume();resolve(response.statusCode);}).on('error',reject);
  });
  assert.equal(status,403);
});

test('portable allowlist contains every static dependency of the Windows main process', async () => {
  const build = await readFile(new URL('../build-portable.ps1', import.meta.url), 'utf8');
  const packaging = await readFile(new URL('../PACKAGING.md', import.meta.url), 'utf8');
  const allowlistBlock = build.match(/\$productFiles\s*=\s*@\(([\s\S]*?)\n\)/);
  assert.ok(allowlistBlock, 'portable product file allowlist exists');
  const productFiles = [...allowlistBlock[1].matchAll(/'([^']+)'/g)].map(match => match[1]);
  const included = new Set(productFiles);
  const visited = new Set();
  async function verifyImports(relative) {
    assert.ok(included.has(relative), `packaged runtime import is missing from productFiles: ${relative}`);
    if (visited.has(relative)) return;
    visited.add(relative);
    const source = await readFile(new URL(`../../${relative}`, import.meta.url), 'utf8');
    const references = new Set([
      ...[...source.matchAll(/\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g)]
        .map(match => match[1] ?? match[2] ?? match[3]),
      ...[...source.matchAll(/^\s*import\s*['"]([^'"]+)['"]/gm)].map(match => match[1]),
    ]);
    for (const reference of references) {
      if (!reference.startsWith('.')) continue;
      const dependency = path.posix.normalize(path.posix.join(path.posix.dirname(relative), reference.split(/[?#]/u, 1)[0]));
      await verifyImports(dependency);
    }
  }
  await verifyImports('desktop-windows/main.mjs');
  assert.match(build, /'web\/reel\/core\.js',[^\n]*'web\/reel\/whisper-languages\.js'/);
  assert.match(packaging, /`core\.js`, `whisper-languages\.js`/);
  assert.match(build, /desktop-windows\/src\/trim-range\.mjs/);
  assert.match(build, /native\/ReelMediaTrim\.exe/);
  assert.match(packaging, /Windows Media Foundation/);
});
