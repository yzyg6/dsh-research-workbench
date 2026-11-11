import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { homedir } from "node:os";
import { WorkspaceRuntime, ROUTES } from './src/server/runtime.mjs';
import { installProjectTools } from './src/server/tools.mjs';
import { installProjectWorkspaces } from './src/server/workspaces.mjs';
import { installWritingModel } from './src/server/writing-model.mjs';
import { installNativeSentenceWriting } from './src/server/native-writing.mjs';
import {installWordFormatting}from'./src/server/word-formatting.mjs';

export const inject = ["connection"];
const directory = fileURLToPath(new URL("./validation/", import.meta.url));

/** Durable business services are independent of native conversation readiness. */
export async function apply(ctx, config = {}) {
  const packageRoot = fileURLToPath(new URL('./', import.meta.url));
  const runtime = new WorkspaceRuntime({ root: config.root || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'workbenches', 'research'), sampleRoot: join(packageRoot, 'samples/figure'), publicRoot: join(packageRoot, 'public') });
  ctx.effect(() => () => runtime.dispose(), 'research-workbench: workspace service');
  await runtime.start();
  for (const path of ROUTES) ctx.effect(() => ctx.connection.fetch.register({ path, methods: /\/(mutate|host-status|word)$/.test(path) ? ['POST'] : ['GET'], requestBody: 'buffered', fetch: (request) => runtime.handle(request) }), `research-workbench: ${path}`);
  const hostReceipt = () => runtime.recordDiagnostic('desktop-server-latest', { version: '0.7.1', implementationVersion:'0.8.0', pid: process.pid, node: process.versions.node, executable: process.execPath, routes: ROUTES.length, integrations: { ...runtime.integrations } }).catch(() => {});
  void hostReceipt();
  ctx.effect(() => runtime.onMutation(() => queueMicrotask(() => void hostReceipt())), 'research-workbench: local startup receipt');
  ctx.plugin({ inject: ['agents', 'tools'], async apply(scope) {
    try { await installProjectTools(scope, runtime); await hostReceipt(); }
    catch { runtime.integrations.projectTools = 'unavailable'; scope.logger?.warn?.('科研项目资料工具未加载；项目页面仍可使用，原生工具接入需检查宿主。'); }
  } });
  ctx.plugin({ inject: ['workspaceRegistry'], async apply(scope) {
    await installProjectWorkspaces(scope, runtime, () => void hostReceipt());
  } });
  ctx.plugin({ inject: ['sessionController'], apply(scope) {
    runtime.nativeFileOpener = request => scope.sessionController.openWorkspacePath(request, AbortSignal.timeout(15000));
    scope.effect(() => () => { runtime.nativeFileOpener = null; }, 'research-workbench: native workspace files');
  } });
  ctx.plugin({ inject: ['llm', 'agentDefaultModel'], async apply(scope) {
    try { await installWritingModel(scope, runtime); await hostReceipt(); }
    catch { runtime.integrations.sentenceModel = 'unavailable'; scope.logger?.warn?.('句子改写模型尚未接入，请检查 DSH 原生模型配置。'); }
  } });
  ctx.plugin({ inject: ['agents', 'tools', 'systemPrompt', 'workspaceRegistry', 'sessionController'], async apply(scope) {
    let connecting=null;
    const reconnect=()=>{if(runtime.nativeWriting.validateSession&&runtime.wordFormatting.ready)return Promise.resolve();if(connecting)return connecting;connecting=installNativeSentenceWriting(scope,runtime).then(()=>installWordFormatting(scope,runtime)).then(()=>hostReceipt()).catch(async error=>{runtime.integrations.nativeSentence='unavailable';await runtime.recordDiagnostic('native-connection-latest',{status:'unavailable',reason:/schema/i.test(error.message||'')?'TOOL_SCHEMA_INVALID':'NATIVE_SETUP_FAILED'});throw error}).finally(()=>{connecting=null});return connecting};
    runtime.reconnectNativeSentence=reconnect;
    scope.effect(()=>()=>{if(runtime.reconnectNativeSentence===reconnect)runtime.reconnectNativeSentence=null},'research-workbench: native reconnection');
    try { await reconnect(); }
    catch { scope.logger?.warn?.('论文修改服务暂未连接，可在工作台重新连接；原稿与会话历史保留。'); }
  } });
  // Keep the previously published phase-zero receipt endpoint compatible.
  ctx.effect(() => ctx.connection.fetch.register({
    path: "/api/research-workbench/report", methods: ["POST"], requestBody: "buffered",
    async fetch(request) {
      const raw = await request.text();
      if (raw.length > 24000) return new Response("report too large", { status: 413 });
      let report;
      try { report = JSON.parse(raw); } catch { return new Response("invalid JSON", { status: 400 }); }
      if (report.schemaVersion !== 1 || !Array.isArray(report.tasks) || report.tasks.length > 3 || !["started", "completed", "restored", "failed"].includes(report.runStatus)) return new Response("invalid report", { status: 400 });
      await mkdir(directory, { recursive: true });
      const name = "dsh-desktop-" + Date.now() + "-" + crypto.randomUUID() + ".json";
      await writeFile(join(directory, name), JSON.stringify(report, null, 2), { encoding: "utf8", flag: "wx" });
      return Response.json({ saved: name });
    },
  }), "research-workbench: diagnostic receipt");
}
