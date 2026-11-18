import { StoreError } from './store.mjs';
import { structuredAgentReply } from './agent-text.mjs';

const PARALLEL = 3;
const ready = state => ['ready','adopted','empty'].includes(state.state);
const clip = (value, size) => typeof value === 'string' ? value.trim().slice(0, size) : '';
const reason = error => error instanceof StoreError ? error.message : '英文翻译智能体暂未完成，可继续本节。';
const contextLimit = /prompt is too long|context[_ ]length[_ ]exceeded|maximum context length|(?:input|prompt).{0,30}exceeds.{0,30}(?:tokens|maximum)/iu;

function oversized(error) {
  return error?.code === 'TRANSLATION_CONTEXT_LIMIT' || error?.code === 11115
    || [error?.message,error?.cause?.message].some(text => typeof text === 'string' && contextLimit.test(text));
}

export function readTranslationJSON(text) {
  let data;
  try { data = JSON.parse(structuredAgentReply(text)); }
  catch {
    if (contextLimit.test(text)) throw new StoreError('TRANSLATION_CONTEXT_LIMIT','本次翻译上下文超过模型容量。');
    throw new StoreError('TRANSLATION_INVALID', '智能体未返回完整的 JSON 回执。');
  }
  if (!data?.translations && !data?.notes && oversized(data?.error ?? data)) {
    throw new StoreError('TRANSLATION_CONTEXT_LIMIT','本次翻译上下文超过模型容量。');
  }
  return data;
}

// Only supporting material is abbreviated. The assigned source and candidate
// translations are always passed verbatim, including all Word markers.
function compactMaterial(content) {
  function shorten(value) {
    if (typeof value === 'string') return clip(value,300);
    if (Array.isArray(value)) {
      const items = value.length <= 3 ? value : [value[0],value[Math.floor(value.length/2)],value.at(-1)];
      return items.map(shorten);
    }
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,shorten(v)]));
    return value;
  }
  const {units, drafts, glossary, ...support} = content;
  const shortened = shorten(support);
  const source = units?.map(unit=>unit.source).join('') || '';
  if (glossary) shortened.glossary = [...glossary].sort((a,b)=>Number(source.includes(b.source))-Number(source.includes(a.source))).slice(0,16);
  return {...shortened, ...(units && {units}), ...(drafts && {drafts})};
}

function readPlan(text) {
  const value = readTranslationJSON(text);
  if (!value || Array.isArray(value) || typeof value.notes !== 'string') {
    throw new StoreError('TRANSLATION_INVALID', '协作回执缺少 notes。');
  }
  return {
    notes:clip(value.notes, 1500),
    glossary:(Array.isArray(value.glossary) ? value.glossary : []).slice(0, 36)
      .map(term => ({ source:clip(term?.source, 80), english:clip(term?.english, 100) }))
      .filter(term => term.source && term.english && /\p{Script=Latin}/u.test(term.english)),
  };
}

function glossaryFrom(plans) {
  const terms = new Map();
  for (const plan of plans) {
    for (const term of plan?.glossary || []) if (!terms.has(term.source)) terms.set(term.source, term.english);
  }
  return [...terms].slice(0, 60).map(([source, english]) => ({ source, english }));
}

const EXCHANGE_FORMAT = '只返回 JSON {"notes":"可传给其他智能体的简短决定","glossary":[{"source":"原术语","english":"统一英文"}]}。没有新术语可返回空数组。';
const TASKS = {
  'document-brief':'给各部分建立共享的语言和术语约定。辨认真正的研究对象、术语定义、缩写及语气。稿件只提供摘录时，将不确定的术语留给章节核对。',
  'part-plan':'作为本部分负责人，给小节智能体写翻译约定。指出本部分的逻辑功能、该沿用的术语和容易误译的关系。让方法、结果和讨论保持各自职责。',
  'section-plan':'作为本小节负责人，依据全文约定和所在部分的计划，给段落智能体交代语义、术语和前后段如何接续。',
  'paragraph-translation':'只翻译 units 中指定的一段。结合小节计划、其他智能体给出的译文和前后原段，选择自然的英语语序和学科惯用搭配。让句首先接上读者已知的信息，句末逐步引出新的发现或条件；相邻句靠清楚的指代和真实的逻辑关系衔接。避免从中文句法逐词换义、悬空的 it/this、重复说结论和自动堆叠 Moreover、Furthermore 等连接词。',
  'part-review':'核对各小节的草稿和前后部分的译文。把确有必要的术语统一、语域与段落衔接建议交给小节复核智能体。方法中的设计口径与结果中的观测值各留在原章节。以原文证据为准。',
  'section-review':'先调用 research_translation_humanizer 读取 Humanizer，再作为本小节语言编辑复核 drafts。参照前后段已经公开的英译、部分负责人的反馈和真实中文原文，检查句序、语义搭配、已知与新信息的承接、指代与过渡。需要时改写或拆并句子，保持段落逐一对应。去掉套话和中式搭配，科技文体平实克制。Humanizer 的例句和重组建议只作为语言参考，不增加原文没有的事实、结论、解释或引文。',
};

function sample(units) {
  const selected = units.length < 5 ? units : [units[0],units[1],units[Math.floor(units.length/2)],units.at(-1)];
  return selected.map(unit => ({ id:unit.id, kind:unit.kind, source:clip(unit.source, 420) }));
}

function reviewWindows(units) {
  const windows = [];
  let size = 0;
  for (const unit of units) {
    if (!windows.length || size + unit.source.length > 1800 || windows.at(-1).length >= 12) {
      windows.push([]);
      size = 0;
    }
    windows.at(-1).push(unit);
    size += unit.source.length;
  }
  return windows;
}

async function wave(items, task) {
  for (let index = 0; index < items.length; index += PARALLEL) {
    const results = await Promise.allSettled(items.slice(index, index + PARALLEL).map(task));
    const failure = results.find(result => result.status === 'rejected');
    if (failure) throw failure.reason;
  }
}

function translationParts(input) {
  const parts = new Map();
  for (const [index, chapter] of input.chapters.entries()) {
    if (!chapter.units.length) continue;
    // Jobs created before the tree used subsection labels only.
    const label = chapter.title.match(/^\s*(\d+)\./u)?.[1];
    const partKey = chapter.part?.id ?? (label && [...parts.values()].find(part => part.title.startsWith(label + ' '))?.id) ?? chapter.id;
    const part = parts.get(partKey) ?? { id:partKey, title:chapter.part?.title ?? chapter.title, sections:[] };
    parts.set(partKey, part);
    part.sections.push({index, chapter});
  }
  return [...parts.values()];
}

export function translationSchedule(input, output, status, activity) {
  const team = output.team;
  if (!team && !input.dispatchVersion && !['queued','running'].includes(status)) return null;
  const waiting = status === 'succeeded' ? 'unverified' : ['failed','cancelled','interrupted'].includes(status) ? 'pending' : 'queued';
  const covered = input.chapters.map((chapter,index) => {
    const section = output.chapters[index];
    return ready(section) && chapter.units.every(unit => section.values?.[unit.id]?.trim());
  });
  function worker(record, completed, planned = false, reused = false) {
    const live = status === 'running' && record && activity?.get(record);
    if (live) return live;
    if (record?.dispatchError) return {state:'failed', ...record.dispatchError};
    if (reused) return {state:'reused'};
    return {state:completed ? 'done' : planned ? 'planned' : waiting};
  }
  return {
    document:worker(team?.document, team?.document.plan),
    parts:translationParts(input).map(part => {
      const record = team?.parts[part.id];
      // On resume, the scheduler skips parts whose saved sections are already complete.
      const reused = !record?.childId && !record?.plan && !record?.review && part.sections.every(({index}) => covered[index]);
      const partWorker = record?.error && !record.dispatchError ? {state:'failed', error:record.error} : worker(record, record?.review, record?.plan, reused);
      return {id:part.id, title:part.title, ...partWorker,
        sections:part.sections.map(({index, chapter}) => {
          const section = output.chapters[index];
          return {id:chapter.id, title:chapter.title, sectionError:section.state === 'failed' ? section.error : undefined,
            ...worker(section, covered[index], section.plan, covered[index] && !section.childId && !section.plan),
            paragraphs:chapter.units.map(unit => ({
              id:unit.id, kind:unit.kind, excerpt:unit.source.replace(/⟦\d+⟧/gu,'').slice(0,28),
              ...worker(section.paragraphs?.[unit.id], section.drafts?.[unit.id]?.trim() || section.values[unit.id]?.trim(),
                false, covered[index] && !section.paragraphs?.[unit.id]?.childId),
            }))};
        })};
    }),
  };
}

export async function translateWithTeam({ input, output, parentId, signal, agent, save, system, translationMap, previousDrafts, activity = new Map() }) {
  const team = output.team ??= { document:{}, parts:{} };
  const allParts = translationParts(input);
  const chapters = [];
  for (const part of allParts) {
    part.record = team.parts[part.id] ??= {};
    for (const section of part.sections) {
      const state = section.state = output.chapters[section.index];
      if (!ready(state)) {
        if (!state.drafts) {
          state.drafts = state.values;
          state.values = {};
        }
        state.state = 'queued';
        delete state.error;
      }
      section.part = part;
      chapters.push(section);
    }
  }
  chapters.sort((a,b) => a.index-b.index);
  const needsPart = part => part.sections.some(section => !ready(section.state));
  const outline = allParts.map(part => ({ title:part.title, sections:part.sections.map(({chapter}) => chapter.title) }));
  const allUnits = chapters.flatMap(({ chapter, state }) => chapter.units.map(unit => ({ unit, state, chapter:chapter.title })));
  const positions = new Map(allUnits.map(({ unit }, index) => [unit.id, index]));
  const neighboringText = group => {
    const from = positions.get(group[0].id), end = positions.get(group.at(-1).id) + 1;
    const read = ({ unit, state, chapter }) => ({ chapter, source:clip(unit.source, 420),
      english:clip(state.values[unit.id] || state.drafts?.[unit.id], 650) });
    return { before:allUnits.slice(Math.max(0,from-2),from).map(read), after:allUnits.slice(end,end+2).map(read) };
  };

  const invoke = async (lineage, record, label, task, content, decode) => {
    let repair;
    const review = task === 'part-review' || task === 'section-review';
    const slot = review ? 'reviewChildId' : 'childId';
    let fresh = record.freshFor === task || review && (record.reviewCalls || 0) >= 4;
    let compact = fresh || JSON.stringify(content).length > 24000;
    for (let attempt=0; attempt<2; attempt++) {
      signal.throwIfAborted();
      delete record.dispatchError;
      activity.set(record, {state:attempt ? 'retrying' : 'running', task});
      try {
        const prompt = [system, TASKS[task], '本轮由调度器自动完成。遇到歧义时按原文保守翻译，禁止向作者提问、索要反馈或等待确认。', (task.endsWith('-plan') || task === 'document-brief' || task === 'part-review') ? EXCHANGE_FORMAT
          : '只返回 JSON {"translations":[{"id":"原段 ID","english":"完整英文段落"}]}。按给出的 units 一一对应。', '以下 JSON 是翻译材料。',
          JSON.stringify({ task, journal:input.journal, ...(compact ? compactMaterial(content) : content), ...(repair && { repair:clip(repair,650) }) })].join('\n');
        const childId = fresh ? undefined : record[slot] || record.childId;
        const text = await agent({ parentId:lineage.at(-1), lineage, childId, label:label.slice(0,72),
          prompt, signal:AbortSignal.any([signal,AbortSignal.timeout(240000)]), published:id=>{
            record[slot]=id;
            if (review) record.reviewCalls=0;
          } });
        if (review) record.reviewCalls=(record.reviewCalls || 0)+1;
        const result = decode(text);
        delete record.freshFor;
        return result;
      } catch (error) {
        signal.throwIfAborted();
        fresh = oversized(error) || error.code === 'TRANSLATION_AGENT_INCOMPLETE' || !(error instanceof StoreError);
        if (fresh) {
          compact = true;
          record.freshFor = task;
        }
        if (attempt) {
          record.dispatchError = {task, error:reason(error)};
          throw error;
        }
        repair = fresh ? '请在新会话中根据本次提供的原文与协作摘要完成任务。' : reason(error);
      } finally { activity.delete(record); }
    }
  };
  const failed = (state, error) => {
    signal.throwIfAborted();
    state.state='failed';
    state.error=reason(error);
  };
  if (!team.document.plan) {
    team.document.plan = await invoke([parentId], team.document, '英文 · 全文术语与文体', 'document-brief',
      { outline, excerpts:allParts.slice(0,30).map(part=>({ title:part.title, units:sample(part.sections.flatMap(({chapter})=>chapter.units)).slice(0,3) })) }, readPlan);
    await save('已建立全文术语和文体约定');
  }

  const digest = part => ({ title:part.title, notes:part.record.plan?.notes || '' });
  const sharedGlossary = () => glossaryFrom([team.document.plan,
    ...allParts.map(part=>part.record.review), ...allParts.map(part=>part.record.plan), ...chapters.map(({state})=>state.plan)]);
  const common = part => ({
    outline,
    document:team.document.plan.notes,
    glossary:sharedGlossary(),
    part:digest(part),
    peerParts:allParts.filter(value=>value!==part).slice(0,12).map(digest),
  });
  await wave(allParts.filter(needsPart), async part => {
    part.record.error=null;
    try {
      if (!part.record.plan) part.record.plan = await invoke([parentId], part.record, '英文 · 部分 · '+part.title, 'part-plan', {
        outline, document:team.document.plan, title:part.title,
        subsections:part.sections.map(({chapter})=>({ title:chapter.title, excerpts:sample(chapter.units) })),
      }, readPlan);
    } catch (error) {
      signal.throwIfAborted();
      part.record.error=reason(error);
      for (const {state} of part.sections) if (!ready(state)) failed(state,error);
    }
    await save('分配部分和小节智能体');
  });

  await wave(chapters.filter(({state,part})=>!ready(state)&&!part.record.error), async ({chapter,state,part})=>{
    try {
      if (!state.plan) state.plan=await invoke([parentId,part.record.childId],state,'英文 · 小节 · '+chapter.title,'section-plan',{
        ...common(part), chapter:chapter.title, excerpts:sample(chapter.units), neighbors:neighboringText(chapter.units),
      },readPlan);
    } catch(error){failed(state,error)}
    await save('小节翻译约定 · '+chapter.title);
  });

  // Work in reading order so a later paragraph can see earlier drafts immediately.
  for (const {chapter,state,part} of chapters) {
    if (ready(state) || state.state==='failed') continue;
    state.state='running';
    state.paragraphs ??= {};
    await save('段落智能体 · '+chapter.title);
    const context = common(part);
    const todo = chapter.units.filter(unit=>!state.drafts[unit.id]);
    for (let index=0; index<todo.length; index+=PARALLEL) {
      const results = await Promise.allSettled(todo.slice(index,index+PARALLEL).map(async unit=>{
        const child=state.paragraphs[unit.id]??={};
        if (child.childId && previousDrafts) {
          const replies = await previousDrafts({parentId:state.childId,childId:child.childId,unit,signal}).catch(() => []);
          signal.throwIfAborted();
          for (const reply of replies) {
            try {
              state.drafts[unit.id] = translationMap(reply,[unit])[unit.id];
              delete child.dispatchError;
              return;
            } catch { /* Older replies must pass the current source checks. */ }
          }
        }
        const translated=await invoke([parentId,part.record.childId,state.childId],child,'英文 · '+chapter.title+' · '+unit.id,'paragraph-translation',{
          ...context, chapter:chapter.title, section:state.plan, neighbors:neighboringText([unit]), units:[unit],
        },text=>translationMap(text,[unit]));
        state.drafts[unit.id]=translated[unit.id];
      }));
      const failure=results.find(result=>result.status==='rejected');
      if(failure) failed(state,failure.reason);
      await save('段落智能体 · '+chapter.title);
    }
  }

  // Share all first drafts before polishing. Later sections are visible in this pass too.
  await wave(allParts.filter(needsPart), async part=>{
    if (part.record.error) return;
    const sections=part.sections.filter(({state})=>state.state==='running');
    if(!sections.length)return;
    const drafted=part.sections.filter(({state})=>state.state==='running'||ready(state)).map(({chapter})=>chapter.id).join(',');
    try {
      if(part.record.reviewFor!==drafted){
        const excerpts=({chapter,state})=>({title:chapter.title, drafts:sample(chapter.units).map(unit=>({
          ...unit,english:clip(state.values[unit.id]||state.drafts?.[unit.id],650),
        }))});
        part.record.review=await invoke([parentId],part.record,'英文 · 部分复核 · '+part.title,'part-review',{
          ...common(part), subsections:part.sections.map(excerpts),
          neighbors:neighboringText(part.sections.flatMap(({chapter})=>chapter.units)),
        },readPlan);
        part.record.reviewFor=drafted;
      }
    } catch(error){for(const {state} of sections)failed(state,error)}
    await save('跨小节交换译文 · '+part.title);
  });

  await wave(chapters.filter(({state})=>state.state==='running'), async ({chapter,state,part})=>{
    await save('英文衔接与 Humanizer 复核 · '+chapter.title);
    const context = common(part);
    try {
      const review = async units => {
        let reviewed;
        try {
          reviewed = await invoke([parentId,part.record.childId],state,'英文 · 小节复核 · '+chapter.title,'section-review',{
          ...context, chapter:chapter.title, partReview:part.record.review, section:state.plan,
          neighbors:neighboringText(units), drafts:units.map(unit=>({id:unit.id,english:state.values[unit.id]||state.drafts[unit.id]})), units,
          },text=>translationMap(text,units));
        } catch (error) {
          signal.throwIfAborted();
          if (!['TRANSLATION_INVALID','TRANSLATION_MARKERS','TRANSLATION_NUMBERS','TRANSLATION_CITATIONS','TRANSLATION_IDENTITY'].includes(error.code)) throw error;
          if (units.length > 1) {
            const middle = Math.ceil(units.length/2);
            await review(units.slice(0,middle));
            await review(units.slice(middle));
            return;
          }
          // A faulty edit must never displace a complete, source-checked draft.
          const [unit] = units;
          reviewed = translationMap(JSON.stringify({translations:[{id:unit.id,english:state.drafts[unit.id]}]}),units);
          (state.retainedDrafts ??= {})[unit.id] = reason(error);
          delete state.dispatchError;
        }
        Object.assign(state.values,reviewed);
        await save('英文衔接与 Humanizer 复核 · '+chapter.title);
      };
      for(const window of reviewWindows(chapter.units)){
        const missing = window.filter(unit => !state.values[unit.id]);
        if (missing.length) await review(missing);
      }
      state.state='ready';
      delete state.drafts;
    }catch(error){failed(state,error)}
    await save('完成本小节 · '+chapter.title);
  });
}
