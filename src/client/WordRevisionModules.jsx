import React from 'react';
import { Icon } from './icons.jsx';
import { PromptPicker } from './RevisionTools.jsx';

export function WordConversationDocument({ project, object, sessionId }) {
  const working = object.metadata?.wordEditable;
  const path = object.metadata?.workspaceFile || object.title;
  return <div className="rw-word-conversation-document" aria-label="当前文稿"
    title={['论文工作区：' + project.rootPath, '当前文稿：' + path, '原生对话：' + (sessionId || '正在关联')].join('\n')}>
    <span className="rw-word-module-icon"><Icon name="file" size={14}/></span>
    <span className="rw-word-module-filename">{object.title}</span>
    <span className="rw-document-role" data-role={working ? 'workspace' : 'original'}>{working ? '工作区版本' : '原稿'}</span>
  </div>;
}

export function WordRevisionScope({ mode, disabled, canUseSelection, feedback, text, connecting, onModeChange, onUseSelection, onRetry }) {
  const id = React.useId();
  const chapter = mode === 'chapter';
  const state = feedback?.state;
  const message = state === 'pending' ? '正在关联到当前对话…'
    : state === 'error' ? feedback.error
    : state === 'ready' ? chapter ? '已关联当前小节' : '已关联当前选句'
    : connecting ? '正在打开论文对话…'
    : !text ? chapter ? '选中同一小节的 2–30 个连续正文段落，然后使用选区。' : '在 Word 中选择要精修的文字。'
    : '';

  return <section className="rw-word-module rw-word-scope" aria-labelledby={id}>
    <div className="rw-word-module-head">
      <h3 id={id}><Icon name="settings" size={14}/>修改范围</h3>
      {chapter && <button type="button" className="rw-word-module-action" disabled={!canUseSelection} onClick={onUseSelection}>使用 Word 选区</button>}
    </div>
    <div className="rw-word-scope-options" role="radiogroup" aria-labelledby={id}>
      {[['sentence', '自然段精修'], ['chapter', '章节优化']].map(([value, name]) =>
        <label key={value}>
          <input type="radio" name={id} value={value} checked={mode === value} disabled={disabled} onChange={() => onModeChange(value)}/>
          <span>{name}</span>
        </label>
      )}
    </div>
    {text && <details className="rw-word-scope-excerpt">
      <summary title={text}>
        <Icon name="chevron" size={11}/>
        <span className="rw-word-scope-label">{chapter ? '小节' : '选句'}</span>
        <span className="rw-word-scope-preview">{text}</span>
      </summary>
      <blockquote>{text}</blockquote>
    </details>}
    <div className="rw-word-module-status" data-state={state} role="status">
      {state === 'ready' && <Icon name="check" size={12}/>}
      {message && <span>{message}</span>}
      {state === 'error' && <button type="button" className="rw-quiet" disabled={disabled} onClick={onRetry}>重试</button>}
    </div>
  </section>;
}

export function PromptTemplateModule({ title, icon, value, onChange, onFill, disabled, prompt, templates, pickerLabel, fillLabel='填入模板', fillTitle, fillDisabled, notice, connecting }) {
  const id = React.useId();
  const [open, setOpen] = React.useState(false);
  return <section className="rw-word-module rw-word-template" aria-label={title}>
    <div className="rw-word-module-head">
      <h3><Icon name={icon} size={14}/>{title}</h3>
      <button type="button" className="rw-word-module-preview-toggle" aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)}>
        {open ? '收起内容' : '查看内容'}<Icon name="down" size={12}/>
      </button>
    </div>
    <div className="rw-word-template-controls">
      {onChange && <PromptPicker value={value} showLabel={false} disabled={disabled} onChange={onChange} templates={templates} label={pickerLabel}/>}
      <button type="button" className="rw-word-module-action" title={fillTitle} disabled={disabled||fillDisabled} onClick={onFill}>
        {fillLabel}<Icon name="arrow" size={13}/>
      </button>
    </div>
    <div id={id} hidden={!open} className="rw-word-template-preview">{prompt}</div>
    <div className="rw-word-module-status" data-state={connecting ? 'pending' : undefined} role="status">
      {connecting ? '正在加入论文工作区…' : notice}
    </div>
  </section>;
}
