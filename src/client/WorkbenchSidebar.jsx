import React from 'react';
import {Icon} from './icons.jsx';
import {TASKS,TASK_LABELS} from '../shared/model.mjs';
const TASK_ICONS={writing:'write',figure:'figure',reading:'read'};

export function WorkbenchSidebar({collapsed,project,task,object,onNewProject,onProjects,onOpenWorkspace,onFiles,onTask,onNote,onSelect,onImport,onResources}){
  return <aside id="rw-project-sidebar" className="rw-sidebar" aria-label="工作台导航" data-collapsed={collapsed}>
    <div className="rw-section-label">研究项目<button className="rw-icon-button" aria-label="新建论文项目" title="新建论文项目" onClick={onNewProject}><Icon name="plus" size={13}/></button></div>
    <button className="rw-project-picker" aria-label="切换论文项目" title={`切换项目 · ${project?.title||'选择或创建项目'}`} onClick={onProjects}><Icon name="folder" size={18}/><span><strong>{project?.title||'选择或创建项目'}</strong><small>{project?.journal||'一篇论文，一个项目'}</small></span><Icon name="down" size={12}/></button>
    <div className="rw-workspace-sidebar"><button className="rw-quiet" aria-label="打开已有工作区" title="打开已有工作区" onClick={onOpenWorkspace}><Icon name="folder" size={15}/><span>打开已有工作区</span></button>{project&&<button className="rw-quiet" aria-label="工作区文件" title="工作区文件" onClick={onFiles}><Icon name="file" size={15}/><span>工作区文件</span></button>}</div>
    <div className="rw-section-label">工作空间</div>
    <nav className="rw-nav" aria-label="研究任务">{TASKS.map(key=><button key={key} aria-label={TASK_LABELS[key]} title={TASK_LABELS[key]} aria-current={task===key?'page':undefined} disabled={!project} onClick={()=>onTask(key)}><Icon name={TASK_ICONS[key]} size={17}/><span>{TASK_LABELS[key]}</span></button>)}</nav>
    <button className="rw-rail-resources rw-icon-button" aria-label="项目资料" title="项目资料" disabled={!project} onClick={onResources}><Icon name="layers" size={18}/></button>
    <div className="rw-section-label">项目资料{project&&<button className="rw-icon-button" aria-label="新建研究笔记" title="新建研究笔记" onClick={onNote}><Icon name="plus" size={13}/></button>}</div>
    <div className="rw-resource-group">{project?.objects.slice(0,30).map(item=><button className="rw-resource" key={item.id} aria-selected={item.id===object?.id} title={item.title} onClick={()=>onSelect(item)}><i className="rw-file-dot" data-kind={item.kind}/><span>{item.title}</span></button>)}{project&&<button className="rw-resource" onClick={onImport}><Icon name="upload" size={13}/><span>导入 Markdown</span></button>}</div>
    <div className="rw-sidebar-foot"><Icon name="folder" size={13}/><span title={project?.rootPath}>{project?'本机研究空间':'开始你的研究'}</span></div>
  </aside>;
}
