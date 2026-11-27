import test from 'node:test';
import assert from 'node:assert/strict';
import {cleanGeneratedSummary,localSummaryPrompt} from '../src/local-generative-summary.mjs';
import {MODEL_CDN_PATHS,SUMMARY_MODEL_ID,SUMMARY_MODEL_PATH,SUMMARY_MODEL_REVISION,SUMMARY_TOKENIZER_MODEL_ID,SUMMARY_TOKENIZER_PATH,SUMMARY_TOKENIZER_REVISION,modelForCachePath,modelForRequestPath,pinModelRequest} from '../local-ai/model-pinning.mjs';

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

test('T5 CNN summarizer and base tokenizer assets are revision-pinned and individually allowlisted',()=>{
  const main=`https://huggingface.co/${SUMMARY_MODEL_ID}/resolve/main/config.json`;
  const request=pinModelRequest(new Request(main));
  assert.equal(request.url,`https://huggingface.co${SUMMARY_MODEL_PATH}config.json`);
  assert.equal(modelForRequestPath(new URL(request.url).pathname).model.revision,SUMMARY_MODEL_REVISION);
  const tokenizerMain=`https://huggingface.co/${SUMMARY_MODEL_ID}/resolve/main/tokenizer.json`;
  const tokenizerRequest=pinModelRequest(new Request(tokenizerMain));
  assert.equal(tokenizerRequest.url,`https://huggingface.co${SUMMARY_TOKENIZER_PATH}tokenizer.json`);
  assert.equal(modelForRequestPath(new URL(tokenizerRequest.url).pathname).model.revision,SUMMARY_TOKENIZER_REVISION);
  const pinnedTokenizer=pinModelRequest(new Request(`https://huggingface.co${SUMMARY_MODEL_PATH}spiece.model`));
  assert.equal(pinnedTokenizer.url,`https://huggingface.co${SUMMARY_TOKENIZER_PATH}spiece.model`);
  const directTokenizerRequest=pinModelRequest(new Request(`https://huggingface.co/${SUMMARY_TOKENIZER_MODEL_ID}/resolve/main/spiece.model`));
  assert.equal(directTokenizerRequest.url,`https://huggingface.co${SUMMARY_TOKENIZER_PATH}spiece.model`);
  const privatePath=modelForRequestPath(`/${SUMMARY_MODEL_ID}/resolve/${SUMMARY_MODEL_REVISION}/private-transcript.txt`);
  assert.equal(privatePath.file,'private-transcript.txt');assert.equal(privatePath.model.files.has(privatePath.file),false);
  const cache=`https://huggingface.co/api/resolve-cache/models/${SUMMARY_MODEL_ID}/${SUMMARY_MODEL_REVISION}/config.json?%2F${SUMMARY_MODEL_ID}%2Fresolve%2F${SUMMARY_MODEL_REVISION}%2Fconfig.json&etag=%22abcdef0123456789abcdef0123456789abcdef01%22`;
  assert.equal(modelForCachePath(new URL(cache))?.file,'config.json');
  assert.equal(modelForCachePath(new URL(cache.replace('config.json?','private-transcript.txt?'))),null);
  assert.ok(MODEL_CDN_PATHS.has('/xet-bridge-us/6aad31d90f859544e744ef1d/fa8a8c26eeb7e447f7cb065a019723dc082760099351540b7812bad7633fbc6f'));
  assert.ok(MODEL_CDN_PATHS.has('/xet-bridge-us/6aad31d90f859544e744ef1d/79da1e37ca464b964c942b66507b1387f904f32533b90a332260ca8201af9c88'));
  assert.equal(MODEL_CDN_PATHS.has('/xet-bridge-us/645181169d916c596e3490a6/25d2f732f698950e8807e07a20bafe057fb7dd69a291e36c81455ca861998d9b'),false);
  assert.equal(MODEL_CDN_PATHS.has('/xet-bridge-us/645181169d916c596e3490a6/366214183dbf2b2c76e4158b6fd6886de2de269d756c5b9857375c9ca9021608'),false);
});
