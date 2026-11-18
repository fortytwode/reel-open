import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {startAssetServer} from '../src/asset-server.mjs';

test('serves only fixed app assets and rejects mutations, host spoofing and traversal', async t=>{
  const server=await startAssetServer();t.after(()=>server.close());
  for(const asset of ['/','/setup.mjs','/setup.css','/capture/','/capture/renderer.mjs',
    '/web/reel/capture.js','/web/reel/core.js','/web/reel/audio.js?v=1','/web/reel/encoder-worker.js',
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
