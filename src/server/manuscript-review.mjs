import { randomUUID } from 'node:crypto';
import { readFile, unlink } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { StoreError } from './store.mjs';
import { REVIEW_DEGREES, REVIEW_RELATION_LABELS } from '../shared/review-relations.mjs';
import { validateProposal } from './writing.mjs';
import { citationMarkers } from './citation-markers.mjs';
import { reviewWordRange } from './review-word-range.mjs';

const TYPE = 'writing.review';
const now = () => new Date().toISOString();
const check = (value, code, message, status = 400) => { if (!value) throw new StoreError(code, message, status); };
const active = status => ['queued', 'running'].includes(status);
const format = '仅返回 JSON 对象。summary 为本小节判断。findings 数组最多 3 项，字段为 index（分派小节中 anchorable 为 true 的段落数字 ID）、quote（同段连续原文，最多 180 字）、issue（问题与影响）、suggestion（建议）、steps（按顺序列出的修改步骤，使用字符串数组）、prompt（可直接使用的中文修改提示词）、scope（paragraph 或 chapter）、links（相关小节数字 ID 数组）。若无可靠问题，findings 返回空数组。';
const instruction = '根据科学论文实际表述检查证据与结论是否匹配，识别术语、定义、数值、单位、方法与结果的衔接。保留不确定性和引用，不生成替换正文，不推断稿件未说明的结果或出处。';
const reviewClassification = '每条另附 reason（说明为何值得改、会影响什么）和 kind（wording 仅措辞，structure 调整信息顺序或章节衔接，meaning 涉及事实、统计口径、方法、结论范围或证据强度）。';
const shape = (value, max) => typeof value === 'string' ? value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]/g, '').trim().slice(0, max).toWellFormed() : '';
const anchorError = '智能体没有返回可核对的原文锚点，可重试该小节。';
const detailError = '已找到原文，但审阅意见缺少建议、修改步骤或提示词，可重试该小节。';
const responseError = '智能体未返回完整的审阅意见，可继续重试。';
const BATCH_PROMPT = '作者已选中一条审阅建议。延续本小节审阅，只为 original 内的正文返回拟议修改。结合前后文和审阅材料中的已确认事实，保持术语和计量口径一致。citationMarkers 按原段落列出允许保留的引用标记，重复次数和字符必须与原文一致，引用留在它支持的论断附近。审阅意见与周边段落里的引用仅供理解，禁止复制进改稿。需要核实、增删或替换的引用写进 warnings，先完成能够安全起草的改动。禁止补造证据、数字或结论。只返回一个 JSON 对象，包含 reason（解释修改理由）、warnings（待核对事项的字符串数组）、evidenceIds（空数组）。段落任务返回 replacement（单段文字），小节任务返回 paragraphs（与原文一一对应，段落数量相同）。';
const BATCH_REPAIR = { CITATION_CHANGED: '上一稿的引用清单与原文不一致。逐项核对 citationMarkers，保留每一处原有标记及其重复次数，去掉从正文之外带入的引用。', INVALID_PROPOSAL: '上一轮改稿的内容或 JSON 格式未通过校验。请按字段要求完整返回一份改稿。', UNSUPPORTED_EVIDENCE: '上一次填入了未验证的证据编号。evidenceIds 应为空数组。' };
const formatSteps = steps => shape(Array.isArray(steps)
  ? steps.slice(0, 12).map(step => shape(step, 900)).filter(Boolean).join('\n')
  : steps, 900);

export function stripReviewEnvelope(text) {
  // Some DSH continuation turns echo the leading ACP metadata block.
  return text.trim().replace(/^<acp(?:\s+[^<>]{1,256})?>[^<>]{0,256}<\/acp>\s*(?=\{|\x60{3})/, '');
}

function batchReplyJSON(text) {
  const reply = text.trim()
    .replace(/^<acp(?:\s+[^<>]{1,256})?>[^<>]{0,256}<\/acp>\s*/, '')
    .replace(/\s*<acp(?:\s+[^<>]{1,256})?>[^<>]{0,256}<\/acp>$/, '').trim();
  const wrapped = reply.match(/^\x60{3}(?:json)?\s*([\s\S]*?)\s*\x60{3}$/i);
  if (wrapped) return wrapped[1];
  const fences = [...reply.matchAll(/^\s*\x60{3}(?:json)?[\t ]*\r?\n([\s\S]*?)\r?\n[\t ]*\x60{3}[\t ]*$/gim)];
  if (fences.length === 1 && !reply.startsWith('{')) return fences[0][1].trim();
  const start = reply.indexOf('{');
  if (start > 0 && start <= 300 && reply.endsWith('}') && fences.length === 0) return reply.slice(start);
  return reply;
}

function decode(text) {
  try {
    const value = JSON.parse(stripReviewEnvelope(text).replace(/^\x60{3}(?:json)?\s*([\s\S]*?)\s*\x60{3}$/i, '$1'));
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch { /* The completed sections remain available for retry. */ }
  throw new StoreError('REVIEW_RESPONSE_INVALID', responseError, 502);
}

function sectionResult(text, section, exact, outline) {
  const result = decode(text), summary = shape(result.summary, 850);
  check(summary && Array.isArray(result.findings), 'REVIEW_RESPONSE_INVALID', '小节审阅意见不完整，可继续重试。', 502);
  const findings = [];
  let hasAnchor = false;
  for (const value of result.findings.slice(0, 3)) {
    const quote = shape(value?.quote, 180);
    if (!section.paragraphs.some(p => p.anchorable && p.index === value?.index) || !quote || !exact[value.index]?.includes(quote)) continue;
    hasAnchor = true;
    const item = {
      index: value.index, quote, issue: shape(value.issue, 650), suggestion: shape(value.suggestion, 700),
      steps: formatSteps(value.steps), prompt: shape(value.prompt, 1500),
      reason: shape(value.reason, 650),
      ...(Object.hasOwn(REVIEW_DEGREES, value.kind) ? { kind: value.kind } : {}),
      scope: value.scope === 'chapter' ? 'chapter' : 'paragraph',
      links: [...new Set(Array.isArray(value.links) ? value.links : [])].filter(id => id !== section.id && outline.some(part => part.id === id)).slice(0, 8),
    };
    if (item.issue && item.suggestion && item.steps && item.prompt) findings.push(item);
  }
  if (result.findings.length) {
    check(hasAnchor, 'REVIEW_ANCHOR_INVALID', anchorError, 502);
    check(findings.length, 'REVIEW_DETAILS_INVALID', detailError, 502);
  }
  return { summary, findings };
}

function summaryRelations(values, findings) {
  const ids = new Set(findings.map(item => item.id)), seen = new Set(), edges = [];
  const hasPath = (from, target, visited = new Set()) => {
    if (from === target) return true;
    if (visited.has(from)) return false;
    visited.add(from);
    return edges.some(edge => edge.kind === 'before' && edge.from === from && hasPath(edge.to, target, visited));
  };
  for (const value of (Array.isArray(values) ? values : []).slice(0, 48)) {
    const { from, to, kind, reason } = value || {};
    if (!ids.has(from) || !ids.has(to) || from === to || !Object.hasOwn(REVIEW_RELATION_LABELS, kind) || !shape(reason, 360)) continue;
    const key = JSON.stringify(kind === 'together' ? [kind, ...[from, to].sort()] : [kind, from, to]);
    if (seen.has(key) || kind === 'before' && hasPath(to, from)) continue;
    seen.add(key);
    edges.push({ from, to, kind, reason: shape(reason, 360) });
  }
  return edges;
}

function orderedFindings(findings, relations, selected) {
  const pending = findings.filter(item => selected.has(item.id)).map(item => item.id);
  const blocked = (relations || []).filter(edge => edge.kind === 'before' && selected.has(edge.from) && selected.has(edge.to));
  const ordered = [];
  while (pending.length) {
    const next = pending.findIndex(id => !blocked.some(edge => edge.to === id && pending.includes(edge.from)));
    ordered.push(...pending.splice(Math.max(0, next), 1));
  }
  return ordered;
}

export class ManuscriptReview {
  constructor(runtime) {
    this.runtime = runtime;
    this.store = runtime.store;
    this.word = runtime.wordEditing;
    this.running = new Map();
  }

  row({ projectId, objectId, jobId }) {
    this.store.object(projectId, objectId);
    const row = this.store.db.prepare("SELECT * FROM jobs WHERE project_id=? AND type=? AND id=? AND json_extract(input,'$.objectId')=?").get(projectId, TYPE, jobId || '', objectId);
    check(row, 'REVIEW_NOT_FOUND', '当前文稿中没有这轮审阅。', 404);
    return { row, input: JSON.parse(row.input), output: JSON.parse(row.output) };
  }

  history({ projectId, objectId }) {
    return this.store.db.prepare("SELECT id,status,phase,created_at,json_extract(input,'$.expectedRevision') revision FROM jobs WHERE project_id=? AND type=? AND json_extract(input,'$.objectId')=? ORDER BY created_at DESC,rowid DESC LIMIT 20").all(projectId, TYPE, objectId);
  }

  status(owner) {
    const { projectId, objectId, jobId } = owner;
    const object = this.store.object(projectId, objectId), history = this.history(owner), available = Boolean(this.agent);
    if (!history.length) return { history, available };
    const { row, input, output } = this.row({ ...owner, jobId: jobId || history[0].id });
    const replyTarget = output.stage === 'followup' && active(row.status) ? output.messages.at(-1)?.target : null;
    const workers = output.workers.map(({ first, cross, ...worker }, i) => ({
      ...worker, status: worker.id === replyTarget ? 'responding' : worker.status,
      path: input.sections[i].path, summary: cross?.summary || first?.summary,
    }));
    const findings = output.findings?.map(item => {
      const decision = output.decisions[item.id] || {};
      const revision = decision.jobId && this.store.db.prepare('SELECT status,output FROM jobs WHERE project_id=? AND id=?').get(projectId, decision.jobId);
      return { ...item, decision: { ...decision, ...(revision ? { status: revision.status, review: JSON.parse(revision.output || 'null')?.review } : {}) } };
    });
    return {
      ...output, history, available, workers, findings, replyTarget,
      batch: this.batchStatus(owner, output), id: row.id, status: row.status, phase: row.phase, error: row.error, instruction: input.instruction,
      revision: input.expectedRevision, documentChanged: object.revision !== (output.commentRevision ?? input.expectedRevision),
    };
  }

  async start({ projectId, objectId, expectedRevision, instruction, operationKey }) {
    this.ready();
    const parentId = this.runtime.nativeWriting.thread(projectId, objectId)?.sessionId;
    const owner = parentId && this.runtime.nativeWriting.sessionOwner(parentId);
    check(owner?.projectId === projectId && owner.objectId === objectId, 'REVIEW_PARENT_UNAVAILABLE', '请先连接此文稿的「对话」，再启动审阅。', 409);
    check(typeof operationKey === 'string' && /^[a-f0-9-]{36}$/i.test(operationKey), 'INVALID_INPUT', '审阅请求无效。');
    const { row, path } = await this.word.source(projectId, objectId);
    check(row.revision === expectedRevision, 'VERSION_CONFLICT', 'Word 已更新，请保存后重新启动审阅。', 409);
    const { sections, paragraphs } = await this.word.inspect({ path, reviewOutline: true });
    check(sections.length && sections.some(part => part.paragraphs.some(p => p.anchorable)), 'REVIEW_EMPTY', '没有可审阅的 Word 正文。');
    const sizes = sections.map(part => part.paragraphs.reduce((sum, p) => sum + p.text.length, 0));
    check(sections.length <= 60 && sizes.every(size => size <= 48000) && sizes.reduce((a, b) => a + b, 0) <= 180000,
      'REVIEW_TOO_LARGE', '审阅支持最多 60 个小节、18 万字，每小节最多 4.8 万字。请检查标题层级和文稿长度。', 413);
    const project = this.store.project(projectId), id = 'j_' + randomUUID(), key = 'review:' + operationKey;
    const input = {
      objectId, parentId, expectedRevision, sha256: row.sha256, question: project.question, language: project.language,
      instruction: shape(instruction, 3000) || '审查各小节的论证、证据和前后衔接。',
      sections: sections.map((section, index) => ({ ...section, id: index + 1 })), paragraphs,
    };
    const output = { stage: 'reading', workers: input.sections.map(({ id }) => ({ id, status: 'waiting' })), messages: [], decisions: {} };
    const jobId = await this.store.write(() => {
      const previous = this.store.db.prepare('SELECT id FROM jobs WHERE project_id=? AND operation_key=?').get(projectId, key);
      if (previous) return previous.id;
      check(this.store.object(projectId, objectId).revision === expectedRevision, 'VERSION_CONFLICT', 'Word 已更新，请重新启动审阅。', 409);
      check(!this.history({ projectId, objectId }).some(item => active(item.status)), 'REVIEW_BUSY', '这份 Word 已有一轮审阅在运行。', 409);
      const stamp = now();
      this.store.db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, projectId, TYPE, 'queued', '已分派小节', JSON.stringify(input), JSON.stringify(output), null, key, null, stamp, stamp);
      return id;
    });
    this.launch({ projectId, objectId, jobId });
    return { jobId };
  }

  ready() {
    check(this.agent, 'REVIEW_UNAVAILABLE', 'DSH 的原生子智能体服务尚未就绪。', 503);
  }

  async update(owner, change) {
    return this.store.write(() => this.store.transaction(() => {
      const { row, output } = this.row(owner);
      const { status = row.status, phase = row.phase, error = row.error } = change(output, row) || {};
      this.saveOutput(row, output, status, phase, error);
    }));
  }

  saveOutput(row, output, status, phase, error = null) {
    this.store.db.prepare('UPDATE jobs SET status=?,phase=?,output=?,error=?,updated_at=? WHERE id=?')
      .run(status, phase, JSON.stringify(output), error, now(), row.id);
  }

  launch(owner) {
    if (this.running.has(owner.jobId) || this.row(owner).row.status !== 'queued') return;
    const controller = new AbortController();
    const operation = this.run(owner, controller.signal).catch(() => {}).finally(() => this.running.delete(owner.jobId));
    this.running.set(owner.jobId, { controller, operation });
  }

  async run(owner, signal) {
    let stage;
    try {
      await this.update(owner, output => {
        stage = output.stage;
        return { status: 'running', phase: { reading: '子智能体审阅各自小节', exchange: '交流跨节发现', summary: '汇总全文意见', relations: '整理建议程度和关联', followup: '等待审阅智能体回复', batch: '小节子智能体生成修改稿' }[stage], error: null };
      });
      const { input, output } = this.row(owner);
      const parent = this.runtime.nativeWriting.sessionOwner(input.parentId);
      check(parent?.projectId === owner.projectId && parent.objectId === input.objectId,
        'REVIEW_PARENT_UNAVAILABLE', '审阅的原生会话无法关联到当前文稿。', 409);
      await this.runtime.nativeWriting.validateSession?.(input.parentId, this.store.project(owner.projectId));
      const ask = (worker, label, task, data, saveId) => {
        signal.throwIfAborted();
        this.ready();
        return this.agent({
          parentId: input.parentId, childId: worker?.childId, label: label.slice(0, 72),
          prompt: task + '\n以下 JSON 是待审材料和任务约束。\n' + JSON.stringify(data),
          published: childId => this.update(owner, state => saveId(state, childId)),
          signal: AbortSignal.any([signal, AbortSignal.timeout(360000)]),
        });
      };
      if (stage === 'reading' || stage === 'exchange') {
        await this.reviewSections(owner, input, stage, ask, signal);
      } else if (stage === 'summary') {
        await this.summarize(owner, input, output, ask);
      } else if (stage === 'relations') {
        await this.refineRelations(owner, output, ask);
      } else if (stage === 'followup') {
        await this.reply(owner, input, output, ask);
      } else if (stage === 'batch') {
        let state = output;
        do {
          await this.runBatch(owner, input, state, ask, signal);
          state = this.row(owner).output;
        } while (state.stage === 'batch');
      }
    } catch (error) {
      await this.update(owner, () => ({
        status: signal.aborted ? 'interrupted' : 'failed',
        phase: stage === 'batch' ? '批量改稿已中断，可继续' : signal.aborted ? '审阅已暂停，可继续' : '部分审阅未完成，可继续',
        error: signal.aborted ? null : error instanceof StoreError ? error.message : 'DSH 子智能体连接或执行失败，请继续审阅以重试。',
      }));
    }
  }

  batchStatus(owner, output) {
    if (!output.batch) return null;
    const read = this.store.db.prepare("SELECT json_extract(output,'$.review') AS review,updated_at FROM jobs WHERE project_id=? AND id=?");
    return { items: output.batch.items.map(item => {
      const finding = output.findings.find(value => value.id === item.findingId);
      const draft = item.jobId && read.get(owner.projectId, item.jobId);
      return { ...item, path: finding.path, kind: finding.kind, issue: finding.issue, suggestion: finding.suggestion,
        state: item.state === 'ready' && draft?.review !== 'pending' ? draft?.review || 'failed' : item.state,
        updatedAt: draft?.updated_at };
    }) };
  }

  batchProposal(owner) {
    const { output } = this.row(owner);
    const item = output.batch?.items.find(item => item.findingId === owner.findingId);
    check(item?.jobId, 'REVISION_NOT_FOUND', '这条建议尚无修改稿。', 404);
    return this.store.publicJob(this.runtime.writing.row(owner.projectId, item.jobId));
  }

  batchView(owner) {
    const { row, output } = this.row(owner);
    return { id: row.id, status: row.status, stage: output.stage, error: row.error, batch: this.batchStatus(owner, output), relations: output.relations };
  }

  async startBatch(owner) {
    this.ready();
    const { findingIds, expectedRevision, retry, scope, operationKey } = owner;
    check(Array.isArray(findingIds) && findingIds.length > 0 && findingIds.length <= 180
      && findingIds.every(id => typeof id === 'string') && typeof operationKey === 'string' && /^[a-f0-9-]{36}$/i.test(operationKey)
      && (!scope || retry && findingIds.length === 1 && scope === 'paragraph'), 'INVALID_INPUT', '请选择需要生成修改稿的审阅建议。');
    await this.update(owner, (output, row) => {
      if (output.batch?.operationKey === operationKey) return;
      const appendRetry = retry === true && output.stage === 'batch' && active(row.status);
      check(appendRetry || row.status === 'succeeded' && output.stage === 'ready' && !this.running.has(owner.jobId)
        && !this.history(owner).some(item => active(item.status)), 'REVIEW_BUSY', '请等当前审阅或改稿完成后再提交。', 409);
      check(this.store.object(owner.projectId, owner.objectId).revision === expectedRevision, 'VERSION_CONFLICT', 'Word 已更新，请保存后再生成修改稿。', 409);
      const items = output.batch?.items || [], current = this.batchStatus(owner, output)?.items || [];
      const findings = new Map(output.findings.map(item => [item.id, item]));
      const choices = new Set(findingIds);
      check([...choices].every(id => {
        const item = findings.get(id), decision = output.decisions[id];
        const previous = current.find(item => item.findingId === id);
        return item && output.workers.some(worker => worker.id === item.workerId && worker.childId)
          && !decision?.dismissed && (!decision?.jobId || decision.jobId === previous?.jobId)
          && (retry ? previous && (previous.state === 'failed' || !appendRetry && ['ready', 'undone'].includes(previous.state)) : !previous);
      }), 'REVIEW_BATCH_SELECTION', '有建议已处理或已进入批量对照，请刷新审阅后重新选择。', 409);
      for (const findingId of orderedFindings(output.findings, output.relations, choices)) {
        const existing = items.find(item => item.findingId === findingId);
        const item = { findingId, state: 'queued', scope: scope === 'paragraph' && retry ? 'paragraph' : existing?.scope || findings.get(findingId).scope };
        if (existing) {
          if (existing.jobId) this.setBatchDraftReview(owner, existing.jobId, 'superseded');
          items[items.indexOf(existing)] = item;
          delete output.decisions[findingId];
        } else items.push(item);
      }
      output.batch = { operationKey, items };
      output.stage = 'batch';
      if (appendRetry) return;
      return { status: 'queued', phase: '等待小节子智能体生成修改稿', error: null };
    });
    this.launch(owner);
    return {};
  }

  async runBatch(owner, input, output, ask, signal) {
    const { projectId, objectId, jobId } = owner;
    const { row, path } = await this.word.source(projectId, objectId);
    const outline = await this.word.inspect({ path, reviewOutline: true });
    check(this.store.object(projectId, objectId).revision === row.revision, 'VERSION_CONFLICT', '读取期间 Word 已更新，请继续生成修改稿。', 409);
    const groups = new Map(), findings = new Map(output.findings.map(item => [item.id, item]));
    const accepted = new Set(this.batchStatus(owner, output).items.filter(item => item.state === 'adopted').map(item => item.findingId));
    for (const item of output.batch.items.filter(item => ['queued', 'running'].includes(item.state))) {
      const finding = findings.get(item.findingId);
      const group = groups.get(finding.workerId) || [];
      group.push({ item, finding });
      groups.set(finding.workerId, group);
    }
    const pending = [...groups];
    const process = async () => {
      while (pending.length && !signal.aborted) {
        const [workerId, group] = pending.shift();
        const worker = output.workers.find(worker => worker.id === workerId);
        for (const { item, finding } of group) {
          if (signal.aborted) return;
          await this.update(owner, state => {
            state.workers.find(worker => worker.id === workerId).status = 'revising';
            state.batch.items.find(value => value.findingId === item.findingId).state = 'running';
          });
          try {
            check(worker?.childId, 'REVIEW_AGENT_UNAVAILABLE', '原小节子智能体的会话不可用。', 409);
            const chapter = item.scope === 'chapter';
            const target = reviewWordRange(outline, { ...finding, scope: item.scope, original: input.paragraphs[finding.index],
              exactRevision: [input.expectedRevision, output.commentRevision].includes(row.revision), useCurrent: true });
            const parsed = await this.word.inspect({ path, ...(chapter ? { chapterSelection: target.wordSelection } : { selection: target.wordSelection }) });
            const selection = chapter ? parsed.chapterParagraphs.join('\n\n') : parsed.selectedText;
            const related = (output.relations || []).filter(({ from, to }) => from === finding.id || to === finding.id).map(edge => {
              const peer = findings.get(edge.from === finding.id ? edge.to : edge.from);
              return { ...edge, otherSuggestion: peer?.suggestion, accepted: accepted.has(peer?.id) };
            });
            const proposal = await this.draftBatchProposal(worker, ask, signal, selection, chapter ? parsed.chapterParagraphs : undefined, {
              task: 'draft-review-revision', scope: item.scope, finding, related, context: target.context,
              original: chapter ? parsed.chapterParagraphs : selection, containingParagraph: chapter ? undefined : target.original,
              summary: output.summary, question: input.question, language: input.language,
            });
            const evidence = { sources: [] };
            await this.store.write(() => this.store.transaction(() => {
              const { row: audit, output: state } = this.row(owner);
              const entry = state.batch.items.find(value => value.findingId === item.findingId);
              const draftId = 'j_' + randomUUID(), stamp = now();
              const draftInput = { objectId, format: 'docx', expectedRevision: row.revision, wordSelection: target.wordSelection, selectedText: selection,
                batchTarget: { path: finding.path, index: target.index, original: target.original, quote: finding.quote, scope: item.scope, chapterBlocks: target.chapterBlocks }, batchFindingId: finding.id,
                ...(chapter ? { conversationKind: 'chapter' } : {}) };
              const draftOutput = { objectId, original: selection, expectedRevision: row.revision, proposal, evidence, review: 'pending',
                ...(chapter ? { originalParagraphs: parsed.chapterParagraphs } : {}) };
              this.store.db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(draftId, projectId, 'writing.sentence', 'succeeded', '审阅改稿完成，等待逐条对照', JSON.stringify(draftInput), JSON.stringify(draftOutput), null, 'review-draft:' + draftId, jobId, stamp, stamp);
              Object.assign(entry, { state: 'ready', jobId: draftId });
              state.decisions[item.findingId] = { jobId: draftId, dismissed: false };
              this.saveOutput(audit, state, audit.status, audit.phase);
            }));
          } catch (error) {
            await this.update(owner, state => {
              const entry = state.batch.items.find(value => value.findingId === item.findingId);
              entry.state = signal.aborted ? 'queued' : 'failed';
              if (!signal.aborted) {
                entry.errorCode = error instanceof StoreError ? error.code : 'REVIEW_AGENT_ERROR';
                entry.error = error instanceof StoreError ? error.message : '小节子智能体连接或执行失败，可重新生成。';
              }
            });
          }
        }
        await this.update(owner, state => { state.workers.find(worker => worker.id === workerId).status = 'standby'; });
      }
    };
    const results = await Promise.allSettled(Array.from({ length: Math.min(3, pending.length) }, process));
    signal.throwIfAborted();
    const failure = results.find(result => result.status === 'rejected');
    if (failure) throw failure.reason;
    await this.update(owner, state => {
      if (state.batch.items.some(item => item.state === 'queued')) return;
      state.stage = 'ready';
      for (const worker of state.workers) if (worker.status === 'revising') worker.status = 'standby';
      const failed = state.batch.items.filter(item => item.state === 'failed').length;
      return { status: 'succeeded', phase: failed ? `批量改稿已结束，${failed} 条可重试` : '批量改稿已结束，子智能体待命' };
    });
  }

  async draftBatchProposal(worker, ask, signal, original, paragraphs, data) {
    const label = '修改 · ' + data.finding.path.at(-1);
    const payload = { ...data, citationMarkers: (paragraphs || [original]).map(citationMarkers) };
    const validate = text => {
      signal.throwIfAborted();
      const json = batchReplyJSON(text);
      check(json.startsWith('{'), 'INVALID_PROPOSAL', '模型未返回有效的改写格式，请重试。', 502);
      const proposal = validateProposal(json, original, { sources: [] }, paragraphs);
      check(proposal.replacement !== original && proposal.reason.trim(), 'INVALID_PROPOSAL', '子智能体未返回有效改动或修改理由。可重新生成这条建议。', 502);
      return proposal;
    };
    const response = await ask(worker, label, BATCH_PROMPT, payload, () => {});
    try {
      return validate(response);
    } catch (error) {
      if (!(error instanceof StoreError) || !Object.hasOwn(BATCH_REPAIR, error.code)) throw error;
      const repair = { code: error.code, message: error.message };
      return validate(await ask(worker, label, `${BATCH_PROMPT}\n${BATCH_REPAIR[error.code]}`, { ...payload, repair }, () => {}));
    }
  }

  setBatchDraftReview(owner, jobId, review) {
    const draft = this.runtime.writing.row(owner.projectId, jobId);
    const value = JSON.parse(draft.output);
    check(['pending', 'undone'].includes(value.review), 'ALREADY_REVIEWED', '此建议已处理，请刷新对照。', 409);
    value.review = review;
    this.store.db.prepare('UPDATE jobs SET output=?,phase=?,updated_at=? WHERE id=?').run(JSON.stringify(value), review === 'skipped' ? '已跳过，保留原文' : '已由新改稿替换', now(), jobId);
  }

  async skipBatchItem(owner) {
    await this.update(owner, output => {
      const item = this.batchStatus(owner, output)?.items.find(item => item.findingId === owner.findingId);
      check(item && ['ready', 'failed'].includes(item.state), 'REVISION_NOT_READY', '仅待核对或生成失败的建议可以跳过。', 409);
      if (item.jobId) this.setBatchDraftReview(owner, item.jobId, 'skipped');
      output.batch.items.find(item => item.findingId === owner.findingId).state = 'skipped';
      output.decisions[item.findingId] = { ...output.decisions[item.findingId], dismissed: true };
    });
    return {};
  }

  async reviewSections(owner, input, stage, ask, signal) {
    const outline = input.sections.map(({ id, path, paragraphs }) => ({ id, path, paragraphs: paragraphs.length }));
    const context = { question: input.question, language: input.language, authorRequest: input.instruction, outline };
    const reviewSection = async (worker, index, field, task, data) => {
      const section = input.sections[index];
      const recoverable = worker.childId && [anchorError, detailError, responseError].includes(worker.error);
      if (recoverable && this.previousSectionReply) {
        try {
          const previous = await this.previousSectionReply({
            parentId: input.parentId, childId: worker.childId, sectionId: section.id, exchange: field === 'cross', signal,
          });
          if (previous) return sectionResult(previous, section, input.paragraphs, outline);
        } catch { signal.throwIfAborted(); }
      }
      const text = await ask(worker, section.title, task + format + reviewClassification, { ...context, section, ...data },
        (state, id) => { state.workers[index].childId = id; });
      return sectionResult(text, section, input.paragraphs, outline);
    };
    if (stage === 'reading') {
      await this.sections(owner, signal, 'first',
        (worker, index) => reviewSection(worker, index, 'first', instruction + ' 你只负责这个小节。'));
      await this.update(owner, state => {
        state.stage = 'exchange';
        return { phase: '交流跨节发现' };
      });
    }
    const first = this.row(owner).output.workers.map((worker, index) => ({
      id: worker.id, path: outline[index].path, summary: worker.first.summary.slice(0, 300),
      findings: worker.first.findings.map(({ issue, quote }) => ({ issue: issue.slice(0, 160), quote: quote.slice(0, 90) })),
    }));
    await this.sections(owner, signal, 'cross', (worker, index) =>
      reviewSection(worker, index, 'cross', instruction +
        ' 其他小节仅提供审阅发现。用这些发现回查你负责的小节，指出存在真实依赖的关联小节，更新问题、步骤与提示词。',
      { first: worker.first, peers: first.filter(peer => peer.id !== worker.id) }));
    await this.update(owner, state => {
      state.findings = state.workers.flatMap((worker, index) => worker.cross.findings.map((item, order) => ({
        ...item, id: worker.id + '-' + (order + 1), workerId: worker.id, path: input.sections[index].path,
      })));
      state.stage = 'comments';
      return { status: 'draft', phase: '小节审阅完成，等待确认 Word 批注' };
    });
  }

  async summarize(owner, input, output, ask) {
    const result = decode(await ask(output.coordinator, '全文审阅汇总',
      '根据所有小节交流后的结果汇总全文审阅。检查全文贯通性并按依赖关系排序，给出修改计划和跨小节统一术语、证据的审阅提示词。标出建议之间有实质依据的关联，before 表示 from 应在 to 之前处理，together 表示两条应同步核对。用 reason 说明具体依赖，同处一个小节或步骤本身不足以判断先后。relations 最多给 36 条。仅输出 JSON：{"summary":"全文审阅结论","plan":[{"step":"可执行步骤","findings":["实际存在的批注ID"]}],"relations":[{"from":"批注ID","to":"批注ID","kind":"before 或 together","reason":"关联依据"}],"prompt":"用于检查跨节一致性的中文提示词"}。没有问题时据实说明，prompt 为空。提示词要求按当前局部选区修改并保留来源与数字。',
      { question: input.question, authorRequest: input.instruction,
        sections: output.workers.map((worker, i) => ({ id: worker.id, path: input.sections[i].path, summary: worker.cross.summary })),
        findings: output.findings.map(({ id, workerId, issue, steps, links }) => ({ id, workerId, issue: issue.slice(0, 300), steps: steps.slice(0, 300), links })) },
      (state, id) => { state.coordinator = { childId: id }; }));
    check(shape(result.summary, 4500), 'REVIEW_RESPONSE_INVALID', '全文汇总不完整，可继续重试。', 502);
    await this.update(owner, state => {
      state.summary = shape(result.summary, 4500);
      state.summaryPrompt = shape(result.prompt, 2200);
      state.plan = (Array.isArray(result.plan) ? result.plan : []).slice(0, 24).map(item => ({
        step: shape(item?.step, 800),
        findings: [...new Set(Array.isArray(item?.findings) ? item.findings : [])].filter(id => state.findings.some(finding => finding.id === id)),
      })).filter(item => item.step);
      state.relations = summaryRelations(result.relations, state.findings);
      state.stage = 'ready';
      return { status: 'succeeded', phase: '全文审阅已汇总，子智能体待命' };
    });
  }

  async reply(owner, input, output, ask) {
    const request = output.messages.findLast(message => message.role === 'user');
    const index = output.workers.findIndex(worker => worker.id === request.target);
    const worker = index < 0 ? output.coordinator : output.workers[index];
    const label = index < 0 ? '全文审阅汇总' : input.sections[index].title;
    const result = decode(await ask(worker, label,
      '回答作者关于本轮审阅的追问。保留已有分工和审阅快照，标明依赖的批注编号和需核对的资料。可以细化修改步骤和提示词。仅返回 JSON 对象 {"answer":"中文回复"}。',
      { question: request.text, findings: output.findings.map(({ id, issue }) => ({ id, issue: issue.slice(0, 200) })) },
      (state, id) => { if (index < 0) state.coordinator = { childId: id }; else state.workers[index].childId = id; }));
    check(shape(result.answer, 6000), 'REVIEW_RESPONSE_INVALID', '追问未收到完整回复，可继续重试。', 502);
    await this.update(owner, state => {
      state.messages.push({ role: 'assistant', target: request.target, text: shape(result.answer, 6000) });
      state.stage = state.summary ? 'ready' : 'comments';
      return { status: state.summary ? 'succeeded' : 'draft', phase: state.summary ? '全文审阅已汇总，子智能体待命' : '小节审阅完成，等待确认 Word 批注' };
    });
  }

  async arrangeRelations(owner) {
    this.ready();
    await this.update(owner, (output, row) => {
      check(row.status === 'succeeded' && output.stage === 'ready' && output.findings?.length
        && !this.history(owner).some(item => item.id !== owner.jobId && active(item.status)), 'REVIEW_BUSY', '请等待审阅汇总完成。', 409);
      output.stage = 'relations';
      return { status: 'queued', phase: '准备整理建议关联', error: null };
    });
    this.launch(owner);
    return {};
  }

  async refineRelations(owner, output, ask) {
    const review = decode(await ask(output.coordinator, '审阅建议关联',
      '根据已有审阅建议判断每项修改的范围，说明为何改，再给出真正存在的前置依赖或同步核对关系。' + reviewClassification +
      '程度衡量建议将改动什么，问题本身涉及研究主题不等于会改动科学含义。单条 reason 一句话，不照抄问题。不得只因两条建议同属一个小节或计划步骤就连线。before 表示 from 应先于 to，together 表示两条建议需同步核对。relations 最多 32 条。仅输出 JSON：{"degrees":[{"id":"已有批注ID","kind":"wording/structure/meaning","reason":"修改依据"}],"relations":[{"from":"已有批注ID","to":"已有批注ID","kind":"before/together","reason":"关联依据"}]}。',
      { task: 'arrange-review-relations', plan: output.plan,
        findings: output.findings.map(({ id, path, issue, suggestion, scope, links }) => ({ id, section: path.at(-1), issue: issue.slice(0, 280), suggestion: suggestion.slice(0, 360), scope, links })) },
      (state, id) => { state.coordinator = { childId: id }; }));
    const degrees = new Map((Array.isArray(review.degrees) ? review.degrees : []).filter(item => item && Object.hasOwn(REVIEW_DEGREES, item.kind) && shape(item.reason, 350))
      .map(({id,kind,reason}) => [id,{kind,reason:shape(reason,350)}]));
    check(output.findings.some(item => degrees.has(item.id)), 'REVIEW_RESPONSE_INVALID', '审阅关联未返回有效分级，可继续重试。', 502);
    await this.update(owner, state => {
      state.findings = state.findings.map(item => ({ ...item, ...degrees.get(item.id) }));
      state.relations = summaryRelations([...(state.relations || []), ...(Array.isArray(review.relations) ? review.relations : [])], state.findings);
      state.stage = 'ready';
      return { status: 'succeeded', phase: '建议关联已整理，子智能体待命' };
    });
  }

  async sections(owner, signal, field, task) {
    const { output } = this.row(owner);
    const pending = output.workers.map((worker, index) => ({ worker, index })).filter(({ worker }) => !worker[field]);
    const failures = [];
    const process = async () => {
      while (pending.length && !signal.aborted) {
        const { worker, index } = pending.shift();
        await this.update(owner, state => {
          state.workers[index].status = field === 'first' ? 'reading' : 'exchange';
          delete state.workers[index].error;
        });
        try {
          const result = await task(worker, index);
          await this.update(owner, state => {
            Object.assign(state.workers[index], { [field]: result, status: field === 'first' ? 'read' : 'standby' });
          });
        } catch (error) {
          failures.push(error);
          await this.update(owner, state => {
            state.workers[index].status = signal.aborted ? 'waiting' : 'failed';
            if (!signal.aborted) state.workers[index].error = error instanceof StoreError ? error.message : '子智能体运行中断。';
          });
        }
      }
    };
    const workers = await Promise.allSettled(Array.from({ length: Math.min(3, pending.length) }, process));
    signal.throwIfAborted();
    const rejected = workers.find(result => result.status === 'rejected');
    if (rejected) throw rejected.reason;
    if (failures.length) throw failures[0];
  }

  async resume(owner) {
    this.ready();
    check(!this.running.has(owner.jobId), 'REVIEW_BUSY', '这轮审阅仍在运行。', 409);
    await this.update(owner, (output, row) => {
      check(['failed', 'interrupted', 'queued'].includes(row.status), 'REVIEW_BUSY', '这轮审阅当前无需继续。', 409);
      check(!this.history(owner).some(item => item.id !== owner.jobId && active(item.status)), 'REVIEW_BUSY', '这份 Word 正在运行另一轮审阅。', 409);
      return { status: 'queued', phase: output.stage === 'batch' ? '等待继续生成修改稿' : '等待继续审阅', error: null };
    });
    this.launch(owner);
    return {};
  }

  pause(owner) {
    this.row(owner);
    this.running.get(owner.jobId)?.controller.abort();
    return {};
  }

  async recover() {
    if (!this.store.db.prepare("SELECT 1 FROM jobs WHERE type=? AND status='queued' LIMIT 1").get(TYPE)) return;
    await this.store.write(() => this.store.db.prepare("UPDATE jobs SET status='interrupted',phase=? WHERE type=? AND status='queued'").run('审阅已暂停，可继续', TYPE));
  }

  async stop() {
    const running = [...this.running.values()];
    for (const task of running) task.controller.abort();
    await Promise.allSettled(running.map(task => task.operation));
  }

  async publish(owner) {
    this.ready();
    const { row, input, output } = this.row(owner);
    check(row.status === 'draft' && output.stage === 'comments', 'REVIEW_NOT_READY', '这轮审阅尚未准备好写入批注。', 409);
    if (output.findings.length === 0) {
      await this.update(owner, (state, latest) => {
        check(latest.status === 'draft' && state.stage === 'comments', 'REVIEW_NOT_READY', '审阅状态已变化。', 409);
        check(!this.history(owner).some(item => item.id !== owner.jobId && active(item.status)), 'REVIEW_BUSY', '这份 Word 正在运行另一轮审阅。', 409);
        state.stage = 'summary';
        return { status: 'queued', phase: '准备全文汇总' };
      });
      this.launch(owner);
      return { count: 0 };
    }
    const { projectId, objectId } = owner;
    const { row: object, path } = await this.word.source(projectId, objectId);
    if (object.sha256 !== input.sha256) {
      const current = await this.word.inspect({ path, reviewOutline: true });
      const sections = current.sections.map((section, index) => ({ ...section, id: index + 1 }));
      check(isDeepStrictEqual(current.paragraphs, input.paragraphs) && isDeepStrictEqual(sections, input.sections),
        'VERSION_CONFLICT', 'Word 的审阅内容已变化。请对当前版本重新审阅后写入批注。', 409);
    }
    const temporary = await this.word.temporary(projectId);
    const commentDate = now().replace(/\.\d{3}Z$/, 'Z');
    try {
      await this.word.inspect({ path, output: temporary, reviewCommentDate: commentDate, reviewComments: output.findings.map(item => ({ ...item, author: item.path.at(-1) })) });
      const revision = await this.word.save({ projectId, objectId, expectedRevision: object.revision, bytes: await readFile(temporary) }, {
        validated: true, reviewComments: true, historyAction: '审阅：写入 ' + output.findings.length + ' 条 Word 批注',
        beforeSave: () => {
          const latest = this.row(owner);
          check(latest.row.output === row.output && latest.row.status === 'draft', 'REVIEW_NOT_READY', '这轮审阅已变化，请重新核对批注。', 409);
          check(!this.history(owner).some(item => item.id !== owner.jobId && active(item.status)), 'REVIEW_BUSY', '这份 Word 正在运行另一轮审阅。', 409);
        },
        afterSave: revision => {
          output.commentRevision = revision;
          output.commentDate = commentDate;
          output.commentBaseRevision = object.revision;
          output.stage = 'summary';
          this.saveOutput(row, output, 'queued', '已写入 Word 批注，准备全文汇总');
        },
      });
      this.launch(owner);
      return { count: output.findings.length, revision };
    } finally { await unlink(temporary).catch(() => {}); }
  }

  async follow(owner) {
    this.ready();
    const text = shape(owner.message, 3000);
    check(text, 'REVIEW_EMPTY', '请输入要追问的问题。');
    await this.update(owner, (output, row) => {
      check(['draft', 'succeeded'].includes(row.status) && ['comments', 'ready'].includes(output.stage)
        && !this.history(owner).some(item => item.id !== owner.jobId && active(item.status)), 'REVIEW_BUSY', '请等待正在运行的审阅。', 409);
      check(owner.target === 0 ? output.coordinator?.childId : output.workers.some(worker => worker.id === owner.target && worker.childId),
        'REVIEW_AGENT_NOT_FOUND', '请选择此轮审阅中待命的子智能体。', 404);
      output.stage = 'followup';
      output.messages.push({ role: 'user', target: owner.target, text });
      return { status: 'queued', phase: '追问已分派' };
    });
    this.launch(owner);
    return {};
  }

  finding(owner) {
    const review = this.row(owner);
    const item = review.output.findings?.find(finding => finding.id === owner.findingId);
    check(item, 'REVIEW_FINDING_NOT_FOUND', '当前审阅中没有该条批注。', 404);
    return { ...review, item };
  }

  async target(owner) {
    const { input, output, item } = this.finding(owner);
    check(owner.scope === 'locate' || !output.batch?.items.some(entry => entry.findingId === item.id), 'REVIEW_BATCH_SELECTION', '这条建议已进入批量对照。', 409);
    const { row, path } = await this.word.source(owner.projectId, owner.objectId);
    const current = await this.word.inspect({ path, reviewOutline: true });
    const { wordSelection } = reviewWordRange(current, { ...item, original: input.paragraphs[item.index], scope: owner.scope,
      exactRevision: [input.expectedRevision, output.commentRevision].includes(row.revision) });
    if (owner.scope === 'locate') return { wordSelection, revision: row.revision };
    const instruction = [item.prompt, '审阅建议：' + item.suggestion, '修改路径：' + item.steps].join('\n');
    const jobId = await this.runtime.nativeWriting.prepare({
      projectId: owner.projectId, objectId: owner.objectId, expectedRevision: row.revision,
      wordSelection, instruction, revisionMode: owner.scope === 'chapter' ? 'chapter' : 'sentence',
      reviewFinding: owner.jobId + ':' + item.id,
    });
    await this.update(owner, state => {
      check(!state.batch?.items.some(entry => entry.findingId === item.id), 'REVIEW_BATCH_SELECTION', '这条建议已进入批量对照。', 409);
      state.decisions[item.id] = { jobId, dismissed: false };
    });
    return { jobId, instruction };
  }

  async decide(owner) {
    const { item } = this.finding(owner);
    await this.update(owner, state => {
      check(!state.batch?.items.some(entry => entry.findingId === item.id), 'REVIEW_BATCH_SELECTION', '请在批量对照中处理这条建议。', 409);
      state.decisions[item.id] = { ...state.decisions[item.id], dismissed: owner.dismissed === true };
    });
    return {};
  }
}
