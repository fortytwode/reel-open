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
  assert.notEqual(server.localAIOrigin,server.origin);
  for(const asset of ['/','/renderer.mjs','/worker.mjs','/transformers.web.min.js','/ort-wasm-simd-threaded.mjs','/ort-wasm-simd-threaded.wasm','/whisper-languages.js','/transformers.LICENSE']) {
    const result=await fetch(server.localAIOrigin+asset);
    assert.equal(result.status,200,asset);
    const policy=result.headers.get('content-security-policy');
    assert.match(policy,/script-src 'self' 'wasm-unsafe-eval' blob:/);
    const connect=policy.match(/connect-src ([^;]+)/)?.[1].split(' ').sort();
    assert.deepEqual(connect,["'self'",'https://cas-bridge.xethub.hf.co','https://cdn-lfs.huggingface.co','https://huggingface.co'].sort());
    assert.doesNotMatch(policy,/cdn\.jsdelivr\.net|https:\/\/\*/);
  }
  assert.equal((await fetch(server.localAIOrigin+'/../../src/auth.mjs')).status,404);
  assert.equal((await fetch(server.origin+'/local-ai/worker.mjs')).status,404);
});

test('portable allowlist contains every static dependency of the Windows main process', async () => {
  const build = await readFile(new URL('../build-portable.ps1', import.meta.url), 'utf8');
  const packaging = await readFile(new URL('../PACKAGING.md', import.meta.url), 'utf8');
  const localWorker=await readFile(new URL('../local-ai/worker.mjs',import.meta.url),'utf8');
  const localUI=await readFile(new URL('../ui/setup.mjs',import.meta.url),'utf8');
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
  assert.match(build,/node_modules\/@huggingface\/transformers\/dist\/transformers\.web\.min\.js/);
  assert.match(build,/node_modules\/onnxruntime-web\/dist\/ort-wasm-simd-threaded\.wasm/);
  assert.match(localWorker,/onnx-community\/whisper-large-v3-turbo/);
  assert.match(localWorker,/360ebcde2559d60bb474678be3c1de9ef347d01a/);
  assert.match(localWorker,/env\.useBrowserCache=true/);
  assert.doesNotMatch(localWorker,/cdn\.jsdelivr\.net/);
  assert.match(localUI,/First use downloads about 1\.1 GB/);
  assert.match(localUI,/never falls back to cloud transcription/);
  assert.match(packaging, /Windows Media Foundation/);
});
