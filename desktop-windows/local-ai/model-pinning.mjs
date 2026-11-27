export const MODEL_ID='onnx-community/whisper-large-v3-turbo';
export const MODEL_REVISION='360ebcde2559d60bb474678be3c1de9ef347d01a';
export const MODEL_PATH=`/${MODEL_ID}/resolve/${MODEL_REVISION}/`;
export const MODEL_FILES=new Set(['added_tokens.json','config.json','generation_config.json','merges.txt','normalizer.json',
  'onnx/decoder_model_merged_quantized.onnx','onnx/encoder_model_quantized.onnx','preprocessor_config.json',
  'quantize_config.json','special_tokens_map.json','tokenizer.json','tokenizer_config.json','vocab.json']);

/** Pin only Transformers.js's known unpinned metadata/config probe. */
export function pinModelRequest(input,init){
  const isRequest=typeof Request!=='undefined'&&input instanceof Request;
  const method=(init?.method??(isRequest?input.method:'GET')).toUpperCase();
  if(method!=='GET')return input;
  let request;
  try{request=isRequest?new Request(input,init):new Request(input,init);}catch{return input;}
  const url=new URL(request.url);
  const prefix=`/${MODEL_ID}/resolve/main/`;
  if(url.protocol!=='https:'||url.hostname!=='huggingface.co'||url.port!==''||url.username||url.password||url.hash||url.search
    ||!url.pathname.startsWith(prefix))return input;
  const file=url.pathname.slice(prefix.length);
  if(!MODEL_FILES.has(file))return input;
  url.pathname=`${MODEL_PATH}${file}`;
  return new Request(url,request);
}

export function withPinnedModelFetch(fetchImpl,{cacheStorage=globalThis.caches,cacheName='transformers-cache'}={}){
  if(typeof fetchImpl!=='function')throw TypeError('A fetch implementation is required.');
  return async(input,init)=>{
    const pinned=pinModelRequest(input,init);
    if(pinned!==input&&cacheStorage&&typeof cacheStorage.open==='function'){
      try{
        const cache=await cacheStorage.open(cacheName),cached=await cache.match(pinned);
        if(cached)return cached;
      }catch{}
    }
    return fetchImpl(pinned,init);
  };
}
