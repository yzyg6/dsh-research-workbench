import { randomUUID, createHash } from 'node:crypto';
import { sentenceAnchor, replaceSentence } from '../../dist/writing-document.mjs';
import { StoreError } from './store.mjs';
import { WritingEvidence } from './writing-evidence.mjs';
import { DEFAULT_REVISION_PROMPT, validateSentenceChanges } from '../shared/revision-review.mjs';

const now = () => new Date().toISOString();
const requireThat = (value, code, message, status = 400) => { if (!value) throw new StoreError(code, message, status); };
const digest = text => createHash('sha256').update(text).digest('hex');
export const DEFAULT_SENTENCE_PROMPT = DEFAULT_REVISION_PROMPT;

export function validateProposal(text, selectedText, evidence) {
  let value; try { value = JSON.parse(text.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '')); } catch { throw new StoreError('INVALID_PROPOSAL', '模型未返回有效的改写格式，请重试。', 502); }
  requireThat(typeof value.replacement === 'string' && value.replacement.trim() && value.replacement.length <= 8000 && !/[\r\n]/.test(value.replacement), 'INVALID_PROPOSAL', '模型未返回完整的单段改写，请重试。', 502);
  requireThat(typeof value.reason === 'string' && value.reason.length <= 4000 && Array.isArray(value.evidenceIds) && value.evidenceIds.length <= 10 && Array.isArray(value.warnings) && value.warnings.length <= 12 && value.warnings.every(x => typeof x === 'string' && x.length <= 2000), 'INVALID_PROPOSAL', '模型依据或说明的格式不完整，请重试。', 502);
  requireThat(value.evidenceIds.every(id => evidence.sources.some(x => x.id === id && !x.synthetic)), 'UNSUPPORTED_EVIDENCE', '模型引用了未检索到的证据或合成资料，结果未采用，请重试。', 502);
  const markers = text => [...text.matchAll(/\[@[^\]]+\]|\[(?:\d+[\s,，–-]*)+\]/g)].map(x => x[0]).sort().join('|');
  requireThat(markers(selectedText) === markers(value.replacement), 'CITATION_CHANGED', '模型更改或新增了引用标记，已拦截；原文保留，请重试。', 502);
  const replacement=value.replacement.trim();
  return { replacement, reason: value.reason, evidenceIds: [...new Set(value.evidenceIds)], warnings: value.warnings, ...(validateSentenceChanges(value.sentenceChanges,selectedText,replacement)?{sentenceChanges:value.sentenceChanges.map(row=>({before:row.before,after:row.after,kind:row.kind,reason:row.reason,source:'model'}))}:{}) };
}
export class SentenceWriting {
  constructor(store, { evidence = new WritingEvidence(store), generate = null } = {}) { this.store = store; this.evidence = evidence; this.generate = generate; }
  row(projectId, jobId) {
    this.store.project(projectId);
    const row = this.store.db.prepare("SELECT * FROM jobs WHERE id=? AND project_id=? AND type='writing.sentence'").get(jobId, projectId);
    requireThat(row, 'REVISION_NOT_FOUND', '未找到当前项目的句子修改。', 404); return row;
  }
  async enqueue({ projectId, objectId, expectedRevision, document, from, to, instruction = DEFAULT_SENTENCE_PROMPT, keywords = '', operationKey, parentJobId = null }, { native = false } = {}) {
    requireThat(typeof instruction === 'string' && instruction.trim() && instruction.length <= 6000 && typeof keywords === 'string' && keywords.length <= 500 && typeof operationKey === 'string' && operationKey.length <= 160 && operationKey, 'INVALID_INPUT', '请填写修改要求，或使用默认提示词。');
    requireThat(native || this.generate, 'MODEL_UNAVAILABLE', '句子改写需要 DSH 原生模型服务。请在 DSH Desktop 打开科研工作台，并确认已选择可用模型。', 503);
    let anchor; try { anchor = sentenceAnchor(document, from, to); } catch (error) { throw new StoreError('INVALID_SELECTION', error.message); }
    requireThat(anchor.markdown.length <= 180000, 'ARTICLE_TOO_LARGE', '当前整篇上下文上限为 18 万字，请拆分稿件后重试。', 413);
    return this.store.write(async () => {
      const object = this.store.object(projectId, objectId), project = this.store.project(projectId);
      requireThat(object.kind === 'manuscript' && object.revision === expectedRevision, 'VERSION_CONFLICT', '稿件版本已变化，请在最新正文中重新选句。', 409);
      const markdown = (await this.store.asset(projectId, objectId)).bytes.toString('utf8');
      requireThat(markdown === anchor.markdown, 'VERSION_CONFLICT', '选句与已保存正文不一致，请先保存当前稿件。', 409);
      const existing = this.store.db.prepare('SELECT * FROM jobs WHERE project_id=? AND operation_key=?').get(projectId, operationKey);
      if (existing) { requireThat(existing.type === 'writing.sentence', 'INVALID_OPERATION', '操作标识已被使用。'); return existing.id; }
      let previousProposal = null;
      if (parentJobId) { const parent = this.row(projectId, parentJobId), previous = JSON.parse(parent.input); requireThat(previous.objectId === objectId && previous.expectedRevision === expectedRevision && previous.from === from && previous.to === to, 'INVALID_PARENT', '上次建议不属于当前选句。'); previousProposal = parent.output ? JSON.parse(parent.output).proposal : null; }
      const id = `j_${randomUUID()}`, stamp = now();
      const input = { projectId, objectId, expectedRevision, document, from, to, selectedText: anchor.selectedText, markdown, sha256: digest(markdown), instruction: instruction.trim(), keywords, question: project.question, journal: project.journal, language: project.language, previousProposal, promptVersion: 1, ...(native ? { native: true } : {}) };
      this.store.db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id, projectId, 'writing.sentence', native ? 'draft' : 'queued', native ? '原生选句会话已准备，等待发送要求' : '等待检索文献与改写', JSON.stringify(input), null, null, operationKey, parentJobId, stamp, stamp);
      return id;
    });
  }
  async phase(row, phase) { return this.store.write(() => this.store.db.prepare("UPDATE jobs SET phase=?,updated_at=? WHERE id=? AND status='running'").run(phase, now(), row.id)); }
  async run(row, callerSignal) {
    const signal = AbortSignal.any([callerSignal, AbortSignal.timeout(240000)]), input = JSON.parse(row.input);
    try {
      requireThat(this.generate, 'MODEL_UNAVAILABLE', 'DSH 原生模型服务尚未加载，请重启宿主后重试。', 503);
      signal.throwIfAborted(); await this.phase(row, '检索 Zotero 与本地文献全文');
      const evidence = await this.evidence.retrieve(input, signal);
      await this.phase(row, `结合整篇稿件与 ${evidence.sources.length} 条全文片段改写`);
      const result = await this.generate({ ...input, jobId: row.id, evidence }, signal);
      signal.throwIfAborted();
      const proposal = validateProposal(result.text, input.selectedText, evidence);
      await this.store.write(() => {
        const stale = this.store.object(row.project_id, input.objectId).revision !== input.expectedRevision;
        this.store.db.prepare("UPDATE jobs SET status=?,phase=?,output=?,updated_at=? WHERE id=? AND status='running'").run(stale ? 'outdated' : 'succeeded', stale ? '稿件已更新，建议保留供参考，请重新选句' : '改写完成，等待对照采用', JSON.stringify({ objectId: input.objectId, original: input.selectedText, expectedRevision: input.expectedRevision, proposal, evidence, instruction: input.instruction, model: result.model, review: 'pending', promptVersion: 1 }), now(), row.id);
      });
    } catch (error) {
      const interrupted = callerSignal.aborted;
      await this.store.write(() => this.store.db.prepare("UPDATE jobs SET status=?,phase='改写未完成，原文保留',error=?,updated_at=? WHERE id=? AND status='running'").run(interrupted ? 'interrupted' : 'failed', error instanceof StoreError ? error.message : signal.aborted ? '改写超时或宿主已退出，请重新选句后重试。' : '文献检索或模型请求未完成，请检查 DSH 模型连接后重试。', now(), row.id));
    }
  }
  async apply({ projectId, jobId }) {
    const row = this.row(projectId, jobId), input = JSON.parse(row.input), output = row.output ? JSON.parse(row.output) : null;
    requireThat(row.status === 'succeeded' && output?.review === 'pending', 'REVISION_NOT_READY', '这条建议当前不能采用。', 409);
    const text = replaceSentence(input.document, input.from, input.to, output.proposal.replacement);
    return this.store.saveObject({ projectId, objectId: input.objectId, expectedRevision: input.expectedRevision, text }, {
      historyAction: '采用修改：'+output.proposal.reason.slice(0,120),
      beforeSave: () => requireThat(JSON.parse(this.row(projectId, jobId).output).review === 'pending', 'ALREADY_REVIEWED', '此建议已处理。', 409),
      afterSave: revision => { output.review = 'adopted'; output.appliedRevision = revision; output.adoptedAt = now(); this.store.db.prepare("UPDATE jobs SET output=?,phase='已采用并保存版本',updated_at=? WHERE id=?").run(JSON.stringify(output), now(), jobId); },
    });
  }
  async undo({ projectId, jobId }) {
    const row = this.row(projectId, jobId), input = JSON.parse(row.input), output = row.output ? JSON.parse(row.output) : null;
    requireThat(output?.review === 'adopted', 'REVISION_NOT_ADOPTED', '这条建议尚未采用或已经撤回。', 409);
    return this.store.saveObject({ projectId, objectId: input.objectId, expectedRevision: output.appliedRevision, text: input.markdown }, {
      historyAction: '撤回上次采用',
      beforeSave: () => requireThat(JSON.parse(this.row(projectId, jobId).output).review === 'adopted', 'ALREADY_REVIEWED', '此建议已处理。', 409),
      afterSave: revision => { output.review = 'undone'; output.undoneRevision = revision; output.undoneAt = now(); this.store.db.prepare("UPDATE jobs SET output=?,phase='已撤回，保留修改历史',updated_at=? WHERE id=?").run(JSON.stringify(output), now(), jobId); },
    });
  }
}
