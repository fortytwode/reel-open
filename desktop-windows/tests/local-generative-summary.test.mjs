import test from 'node:test';
import assert from 'node:assert/strict';
import {cleanGeneratedSummary,localSummaryPrompt} from '../src/local-generative-summary.mjs';
import {SUMMARY_MODEL_ID,SUMMARY_MODEL_PATH,SUMMARY_MODEL_REVISION,modelForCachePath,modelForRequestPath,pinModelRequest} from '../local-ai/model-pinning.mjs';

test('summary prompt samples long walkthroughs and bounds every input',()=>{
  const segments=Array.from({length:100},(_,index)=>({start:index*60,text:`Step ${index}: select a region and export its report.`}));
  const prompt=localSummaryPrompt(segments);
  assert.ok(prompt.length<=1_700);assert.match(prompt,/\[0:00\]/);assert.match(prompt,/\[99:00\]/);
  assert.throws(()=>localSummaryPrompt({}),/invalid/u);
  assert.equal(localSummaryPrompt([{start:0,text:'  \n  '}]),'');
});

test('generated text is normalized and malformed or very short output falls back',()=>{
  assert.equal(cleanGeneratedSummary('Summary: “The reviewer filters revenue by region, then exports the current report.”'),
    'The reviewer filters revenue by region, then exports the current report.');
  assert.equal(cleanGeneratedSummary('OK'),null);
  assert.equal(cleanGeneratedSummary('   '),null);
});

test('Flan-T5 assets are revision-pinned and only their exact files enter the local model allowlist',()=>{
  const main=`https://huggingface.co/${SUMMARY_MODEL_ID}/resolve/main/config.json`;
  const request=pinModelRequest(new Request(main));
  assert.equal(request.url,`https://huggingface.co${SUMMARY_MODEL_PATH}config.json`);
  assert.equal(modelForRequestPath(new URL(request.url).pathname).model.revision,SUMMARY_MODEL_REVISION);
  const privatePath=modelForRequestPath(`/${SUMMARY_MODEL_ID}/resolve/${SUMMARY_MODEL_REVISION}/private-transcript.txt`);
  assert.equal(privatePath.file,'private-transcript.txt');assert.equal(privatePath.model.files.has(privatePath.file),false);
  const cache=`https://huggingface.co/api/resolve-cache/models/${SUMMARY_MODEL_ID}/${SUMMARY_MODEL_REVISION}/config.json?%2F${SUMMARY_MODEL_ID}%2Fresolve%2F${SUMMARY_MODEL_REVISION}%2Fconfig.json&etag=%22abcdef0123456789abcdef0123456789abcdef01%22`;
  assert.equal(modelForCachePath(new URL(cache))?.file,'config.json');
  assert.equal(modelForCachePath(new URL(cache.replace('config.json?','private-transcript.txt?'))),null);
});
