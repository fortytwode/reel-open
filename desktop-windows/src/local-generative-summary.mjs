const MAX_INPUT_CHARS=1_700;
const MAX_SEGMENT_CHARS=240;

function timestamp(seconds){
  const value=Math.max(0,Math.floor(seconds));
  return `${Math.floor(value/60)}:${String(value%60).padStart(2,'0')}`;
}

/** Keep a short, evenly sampled transcript prompt within T5-small's 512-token context. */
export function localSummaryPrompt(segments){
  if(!Array.isArray(segments)||segments.length>50_000)throw Error('Local summary input is invalid.');
  const valid=segments.filter(segment=>typeof segment?.text==='string'&&Number.isFinite(segment.start)&&segment.start>=0)
    .map(segment=>({start:segment.start,text:segment.text.replace(/\s+/gu,' ').trim()}))
    .filter(segment=>segment.text)
    .map(segment=>`[${timestamp(segment.start)}] ${segment.text}`);
  if(!valid.length)return '';
  const full=valid.map(line=>line.slice(0,MAX_SEGMENT_CHARS)).join('\n');
  if(full.length<=MAX_INPUT_CHARS)return full;
  const count=Math.max(4,Math.floor(MAX_INPUT_CHARS/(MAX_SEGMENT_CHARS+1)));
  const selected=[];
  for(let i=0;i<count;i++){
    const index=Math.round(i*(valid.length-1)/(count-1));
    const line=valid[index].slice(0,MAX_SEGMENT_CHARS);
    if(line&&!selected.includes(line))selected.push(line);
  }
  return selected.join('\n').slice(0,MAX_INPUT_CHARS);
}

export function cleanGeneratedSummary(value){
  if(typeof value!=='string')return null;
  const result=value.replace(/\s+/gu,' ').trim().replace(/^(?:summary\s*:\s*)/iu,'').replace(/^['"“”]+|['"“”]+$/gu,'').trim();
  const chars=Array.from(result);
  if(chars.length<30)return null;
  return chars.length>700?chars.slice(0,699).join('').trimEnd()+'…':result;
}
