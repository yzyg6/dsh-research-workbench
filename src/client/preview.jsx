import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.jsx';
import { defaultTaskState } from '../shared/model.mjs';

const now = new Date().toISOString();
const manuscript = '# 分组干预对时序响应的影响\n\n本文使用合成实验数据，展示如何将研究问题、测量结果和图表保存在同一个论文项目中。数据不代表真实研究结论。\n\n## 1 研究问题\n\n不同分组的响应指标如何随测量时间变化？本研究关注组别与时间两个维度，先梳理可回答的问题，再组织数据、图表和正文中的证据。\n\n## 2 数据与研究设计\n\n实验包含对照组、处理 A 和处理 B。测量时间为第 0、7、14、21 天，每个组别与时间组合包含 6 个独立样本，共 72 条观测。响应指标以任意单位记录。\n\n统计汇总保留样本量、均值和样本标准差。图 1 与原始数据一起保存，后续采用到正文时保留各自的版本身份。\n\n## 3 论证与证据\n\n先判断当前图表能够支持哪些描述，再决定正文中的表达范围。研究问题、原始数据和图注之间的关联可以在项目资料中查看。\n\n- 数据来源：固定随机种子的专用合成实验表。\n- 图表来源：已验证的 Matplotlib 绘图样例。\n- 当前用途：验证论文项目的界面与状态恢复。';
const data = await fetch('/preview-data.csv').then((response) => response.text());
let state = { activeProjectId: 'preview-research', projects: [{ id: 'preview-research', title: '分组干预与时序响应', question: '不同分组的响应指标如何随时间变化，哪些变化能够由现有数据与图表支持？', journal: '目标期刊待定', language: 'zh', isDemo: true, activeTask: 'writing', createdAt: now, updatedAt: now,
  taskStates: Object.fromEntries(['writing', 'figure', 'reading'].map((task) => [task, { revision: 1, value: defaultTaskState(task) }])), bindings: {}, jobs: [], dependencies: [],
  objects: [{ id: 'preview-manuscript', projectId: 'preview-research', kind: 'manuscript', title: '论文主稿', revision: 1, text: manuscript, updatedAt: now, metadata: {} }, { id: 'preview-data', projectId: 'preview-research', kind: 'data', title: 'experiment.csv', revision: 1, text: data, updatedAt: now, metadata: {} }, { id: 'preview-figure', projectId: 'preview-research', kind: 'figure', title: '图 1 · 时序响应', revision: 1, text: '', updatedAt: now, metadata: { caption: '合成响应随时间变化及第 21 天的组间分布。误差线为标准差。' } }, { id: 'preview-note', projectId: 'preview-research', kind: 'note', title: '文献与证据笔记', revision: 1, text: '# 文献与证据笔记\n\n优先使用 Zotero 和本地已解析的文献。每一条引用依据保留原文位置和适用条件。\n\n当前为合成项目示例，尚未添加真实论文。', updatedAt: now, metadata: {} }] }] };
const api = {
  bootstrap: async () => structuredClone(state), assetUrl: () => '/preview-figure.png', versions: async () => [{ revision: 1, createdAt: now, sha256: 'preview-only-no-persistence' }],
  async mutate(action, args) {
    const owner = state.projects.find((project) => project.id === args.projectId);
    if (action === 'saveTaskState') owner.taskStates[args.task] = { revision: owner.taskStates[args.task].revision + 1, value: { ...owner.taskStates[args.task].value, ...(args.patch || args.value) } };
    else if (action === 'updateProject') Object.assign(owner, args.patch);
    else if (action === 'saveObject') { const object = owner.objects.find((item) => item.id === args.objectId); object.text = args.text; object.revision++; }
    else if (action === 'activateProject') state.activeProjectId = args.projectId;
    else throw new Error('界面预览中的此操作将在项目服务接入后提供。');
    return structuredClone(state);
  },
};
createRoot(document.getElementById('root')).render(<App api={api} preview />);
