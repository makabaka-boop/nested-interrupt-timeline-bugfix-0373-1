/**
 * 中断控制器回放页面（纯前端、无硬件连接、无第三方运行时）。
 * 时间轴与逐 tick 表格引用同一份 trace（轨迹），点击任一视图的 tick
 * 会联动高亮另一视图与当前状态卡。
 */

import { LineConfig, ScheduledEvent, TickRecord } from './model';
import { ReplayController, runReplay, validateInput } from './simulator';
import { DEMOS } from './scenarios';

// ---------- DOM ----------
const $ = <T extends HTMLElement>(sel: string): T => document.querySelector(sel)!;

const els = {
  demo: $<HTMLSelectElement>('#demo'),
  desc: $<HTMLParagraphElement>('#desc'),
  linesJson: $<HTMLTextAreaElement>('#linesJson'),
  eventsJson: $<HTMLTextAreaElement>('#eventsJson'),
  load: $<HTMLButtonElement>('#load'),
  reset: $<HTMLButtonElement>('#reset'),
  step: $<HTMLButtonElement>('#step'),
  step5: $<HTMLButtonElement>('#step5'),
  runAll: $<HTMLButtonElement>('#runAll'),
  errors: $<HTMLDivElement>('#errors'),
  warns: $<HTMLDivElement>('#warns'),
  chips: $<HTMLDivElement>('#chips'),
  tickNo: $<HTMLSpanElement>('#tickNo'),
  remaining: $<HTMLSpanElement>('#remaining'),
  stackView: $<HTMLDivElement>('#stackView'),
  pendingBox: $<HTMLDivElement>('#pendingBox'),
  levelBox: $<HTMLDivElement>('#levelBox'),
  maskBox: $<HTMLDivElement>('#maskBox'),
  timeline: $<HTMLDivElement>('#timeline'),
  tabs: document.querySelectorAll<HTMLButtonElement>('.tabs button'),
  viewTimeline: $<HTMLDivElement>('#viewTimeline'),
  viewTable: $<HTMLDivElement>('#viewTable'),
  viewLogs: $<HTMLDivElement>('#viewLogs'),
  trunc: $<HTMLDivElement>('#trunc'),
};

interface LoadedConfig {
  lines: LineConfig[];
  events: ScheduledEvent[];
}

let config: LoadedConfig | null = null;
let controller: ReplayController | null = null;
let selectedTick = 0;
const LINE_COLORS = ['#5b9dff', '#3fb96b', '#e0a83d', '#ff6b6b', '#b07cf7', '#3fc9c0', '#ff8fcf', '#9dff5b'];

function lineColor(id: string): string {
  if (!config) return '#888';
  const idx = config.lines.findIndex((l) => l.id === id);
  return LINE_COLORS[idx % LINE_COLORS.length];
}

// ---------- 初始化演示下拉 ----------
for (const d of DEMOS) {
  const o = document.createElement('option');
  o.value = d.name;
  o.textContent = d.name;
  els.demo.appendChild(o);
}

els.demo.addEventListener('change', () => fillDemo(els.demo.selectedIndex - 1));

function fillDemo(i: number): void {
  if (i < 0 || i >= DEMOS.length) return;
  const d = DEMOS[i];
  els.demo.selectedIndex = i + 1;
  els.desc.textContent = d.description;
  els.linesJson.value = JSON.stringify(d.lines, null, 2);
  els.eventsJson.value = JSON.stringify(d.events, null, 2);
}

function tryParse(): LoadedConfig | null {
  els.errors.textContent = '';
  els.warns.textContent = '';
  let lines: LineConfig[];
  let events: ScheduledEvent[];
  try {
    lines = JSON.parse(els.linesJson.value);
  } catch (e) {
    els.errors.textContent = '中断线 JSON 解析失败：' + (e as Error).message;
    return null;
  }
  try {
    events = JSON.parse(els.eventsJson.value);
  } catch (e) {
    els.errors.textContent = '事件 JSON 解析失败：' + (e as Error).message;
    return null;
  }
  const { errors, warnings } = validateInput(lines, events);
  if (errors.length) {
    els.errors.textContent = errors.map((e) => '• ' + e).join('\n');
    return null;
  }
  if (warnings.length) els.warns.textContent = warnings.map((w) => '• ' + w).join('\n');
  return { lines, events };
}

function loadConfig(): void {
  const cfg = tryParse();
  if (!cfg) return;
  config = cfg;
  controller = new ReplayController(cfg.lines, cfg.events, validateInput(cfg.lines, cfg.events).warnings);
  selectedTick = 0;
  renderChips();
  render();
}

els.load.addEventListener('click', loadConfig);
els.reset.addEventListener('click', () => {
  if (config) controller = new ReplayController(config.lines, config.events, controller?.warnings ?? []);
  selectedTick = 0;
  render();
});
els.step.addEventListener('click', () => {
  controller?.step();
  selectedTick = controller?.ticks.length ?? 0; // 跟随最新 tick
  render();
});
els.step5.addEventListener('click', () => {
  controller?.advance(5);
  selectedTick = controller?.ticks.length ?? 0;
  render();
});
els.runAll.addEventListener('click', () => {
  if (!config) return;
  // 整批回放与逐 tick 走同一个状态机；这里直接跑到静止/500。
  while (controller!.step() !== null) {
    /* drain */
  }
  selectedTick = controller?.ticks.length ?? 0;
  render();
});

// tab 切换
els.tabs.forEach((b) =>
  b.addEventListener('click', () => {
    els.tabs.forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    const v = b.dataset.view!;
    els.viewTimeline.style.display = v === 'timeline' ? '' : 'none';
    els.viewTable.style.display = v === 'table' ? '' : 'none';
    els.viewLogs.style.display = v === 'logs' ? '' : 'none';
  })
);

// ---------- 配置概览 ----------
function renderChips(): void {
  els.chips.innerHTML = '';
  if (!config) return;
  for (const l of config.lines) {
    const c = document.createElement('span');
    c.className = 'chip';
    c.innerHTML = `<b style="color:${lineColor(l.id)}">${l.id}</b> · p${l.priority} · ${
      l.mode === 'edge' ? '边沿' : '电平'
    } · ${l.handlerTicks}t${l.initiallyMasked ? ' · 已屏蔽' : ''}`;
    els.chips.appendChild(c);
  }
}

// ---------- 当前 tick 状态卡 ----------
function currentRecord(): TickRecord | null {
  if (!controller || controller.ticks.length === 0) return null;
  const idx = selectedTick > 0 ? selectedTick - 1 : controller.ticks.length - 1;
  return controller.ticks[Math.min(idx, controller.ticks.length - 1)] ?? null;
}

function renderState(rec: TickRecord | null): void {
  els.tickNo.textContent = rec ? String(rec.tick) : controller ? '0（未开始）' : '—';
  if (!rec) {
    els.stackView.innerHTML = '<span class="hint">无执行帧</span>';
    els.pendingBox.innerHTML = '<span class="hint">—</span>';
    els.levelBox.innerHTML = '<span class="hint">—</span>';
    els.maskBox.innerHTML = '<span class="hint">—</span>';
    els.remaining.textContent = '—';
    return;
  }
  els.remaining.textContent = rec.topRemaining === null ? '空闲' : `${rec.topRemaining} tick`;

  // 执行栈（自底向上）
  els.stackView.innerHTML = '';
  if (rec.stack.length === 0) {
    els.stackView.innerHTML = '<span class="hint">CPU 空闲</span>';
  }
  rec.stack.forEach((f, i) => {
    const cfg = config!.lines.find((l) => l.id === f.lineId)!;
    const top = i === rec.stack.length - 1;
    const pct = Math.round((f.elapsed / f.total) * 100);
    const div = document.createElement('div');
    div.className = 'frame' + (top ? ' top' : '');
    div.style.borderLeftColor = lineColor(f.lineId);
    div.innerHTML = `
      <div style="flex:1">
        <b style="color:${lineColor(f.lineId)}">${f.lineId}</b>
        <span class="mono2"> p${cfg.priority} · ${cfg.mode === 'edge' ? '边沿' : '电平'}</span>
        <div class="bar"><i style="width:${pct}%;background:${lineColor(f.lineId)}"></i></div>
      </div>
      <div class="mono2" style="white-space:nowrap">${f.elapsed}/${f.total} tick</div>`;
    els.stackView.appendChild(div);
  });

  els.pendingBox.innerHTML = rec.pending.length
    ? rec.pending
        .map(
          (p) =>
            `<span class="pill ${p.kind}" style="border-color:${lineColor(p.lineId)}">${p.lineId} · since t${p.since} · ×${p.hits}</span>`
        )
        .join('')
    : '<span class="hint">无待处理位</span>';
  els.levelBox.innerHTML = rec.levelAsserted.length
    ? rec.levelAsserted.map((id) => `<span class="pill level" style="border-color:${lineColor(id)}">${id} 电平有效</span>`).join('')
    : '<span class="hint">无有效电平</span>';
  els.maskBox.innerHTML = rec.masked.length
    ? rec.masked.map((id) => `<span class="pill mask" style="border-color:${lineColor(id)}">${id} 屏蔽中</span>`).join('')
    : '<span class="hint">无屏蔽</span>';
}

// ---------- 时间轴（与表格共用 controller.ticks 同一条轨迹）----------
function actionTag(r: TickRecord): { text: string; cls: string; color: string } {
  switch (r.action.type) {
    case 'enter':
      return { text: '进入', cls: 'enter', color: 'var(--enter)' };
    case 'preempt':
      return { text: `抢→${r.action.by}`, cls: 'preempt', color: 'var(--preempt)' };
    case 'resume':
      return { text: '恢复', cls: 'resume', color: 'var(--resume)' };
    case 'continue':
      return { text: '执', cls: 'continue', color: 'var(--continue)' };
    case 'idle':
      return { text: '·', cls: 'idle', color: 'var(--idle)' };
  }
}

function eventsAt(t: number): Map<string, ScheduledEvent['kind']> {
  const m = new Map<string, ScheduledEvent['kind']>();
  const rec = controller?.ticks[t - 1];
  if (rec) for (const e of rec.eventsApplied) m.set(e.lineId, e.kind);
  return m;
}

function renderTimeline(): void {
  if (!controller || !config) {
    els.timeline.innerHTML = '<p class="hint">载入配置后显示时间轴。</p>';
    return;
  }
  const ticks = controller.ticks;
  const last = Math.max(ticks.length, 1);
  let html = '<div class="timeline-wrap"><table class="timeline">';
  // 表头
  html += '<tr><th style="width:80px;min-width:80px;position:sticky;left:0;z-index:2;background:var(--panel)">tick</th>';
  for (let t = 1; t <= last; t++) html += `<th>${t}</th>`;
  html += '</tr>';

  // CPU 行
  html += '<tr><td style="position:sticky;left:0;background:var(--panel);font-size:10px;color:var(--muted)">CPU 动作</td>';
  for (let t = 1; t <= last; t++) {
    const r = ticks[t - 1];
    const tag = r ? actionTag(r) : null;
    const sel = selectedTick === t ? ' selected' : '';
    html += `<td class="cell idle${sel}" data-tick="${t}" style="${tag && tag.cls !== 'idle' ? `color:${tag.color}` : ''}">${
      tag ? tag.text : ''
    }</td>`;
  }
  html += '</tr>';

  // 每线一行
  for (const line of config.lines) {
    const color = lineColor(line.id);
    html += `<tr><td style="position:sticky;left:0;background:var(--panel);font-size:10px"><b style="color:${color}">${line.id}</b> <span class="mono2">p${line.priority}</span></td>`;
    for (let t = 1; t <= last; t++) {
      const r = ticks[t - 1];
      const ev = r ? eventsAt(t).get(line.id) : undefined;
      let bg = '';
      let content = '';
      let title = '';
      if (r) {
        const onStack = r.stack.some((f) => f.lineId === line.id);
        const top = r.stack[r.stack.length - 1];
        const isTop = top && top.lineId === line.id;
        const pend = r.pending.find((p) => p.lineId === line.id);
        if (onStack) {
          bg = isTop
            ? `background:${color}55;box-shadow:inset 0 0 0 1px ${color}`
            : `background:${color}22`;
          content = isTop ? '▶' : '∥';
          title = isTop ? '正在执行' : '被抢占挂起';
        } else if (pend) {
          content = `P${pend.hits > 1 ? pend.hits : ''}`;
          title = `待处理 since t${pend.since}，合并 ${pend.hits} 次`;
        } else if (line.mode === 'level' && r.levelAsserted.includes(line.id)) {
          content = '~';
          title = '输入电平有效';
        }
        if (r.completed?.lineId === line.id) {
          content = '■';
          title = '本 tick 处理完成（上一 tick 执行收尾）';
        }
      }
      const evCls = ev ? ` ev-${ev}` : '';
      const sel = selectedTick === t ? ' selected' : '';
      html += `<td class="cell${evCls}${sel}" data-tick="${t}" style="${bg}" title="t${t} ${line.id}：${title}${
        ev ? '；事件 ' + ev : ''
      }">${content}</td>`;
    }
    html += '</tr>';
  }
  html += '</table></div>';
  els.timeline.innerHTML = html;

  els.timeline.querySelectorAll<HTMLElement>('td.cell').forEach((td) => {
    td.addEventListener('click', () => selectTick(Number(td.dataset.tick)));
  });
}

// ---------- 逐 tick 表格 ----------
function renderTable(): void {
  if (!controller || !config) {
    els.viewTable.innerHTML = '<p class="hint">载入配置后显示逐 tick 记录。</p>';
    return;
  }
  let html = '<table class="records"><tr><th>tick</th><th>事件(阶段A)</th><th>完成(阶段B)</th><th>动作(阶段C/D)</th><th>执行栈（底→顶）</th><th>待处理证据</th></tr>';
  for (const r of controller.ticks) {
    const evs = r.eventsApplied.length
      ? r.eventsApplied
          .map(
            (e) =>
              `<span class="tag event">${e.lineId}·${eventZh(e.kind)}${
                e.kind === 'setPriority' ? `→p${e.priority}` : e.kind === 'setMode' ? `→${e.mode === 'edge' ? '边沿' : '电平'}` : ''
              }</span>`
          )
          .join(' ')
      : '<span class="mono2">—</span>';
    const comp = r.completed ? `<span class="tag complete">${r.completed.lineId} 完成</span>` : '<span class="mono2">—</span>';
    let actionDesc: string;
    if (r.action.type === 'preempt')
      actionDesc = `<span class="tag preempt">抢占</span> ${r.action.by} 抢占 ${r.action.resumed}`;
    else if (r.action.type === 'enter')
      actionDesc = `<span class="tag enter">进入</span> ${r.action.lineId}（剩余 ${r.topRemaining}）`;
    else if (r.action.type === 'resume')
      actionDesc = `<span class="tag resume">恢复</span> ${r.action.lineId}（剩余 ${r.topRemaining}）`;
    else if (r.action.type === 'continue')
      actionDesc = `<span class="tag continue">执行</span> ${r.action.lineId}（剩余 ${r.topRemaining}）`;
    else actionDesc = '<span class="tag idle">空闲</span>';
    const stack = r.stack.length
      ? r.stack
          .map((f) => {
            const top = f === r.stack[r.stack.length - 1];
            return `<span style="color:${lineColor(f.lineId)}">${top ? '▶' : '∥'}${f.lineId}(${f.elapsed}/${f.total})</span>`;
          })
          .join(' ← ')
      : '<span class="mono2">∅</span>';
    const pend = r.pending.length
      ? r.pending
          .map((p) => `<span class="pill ${p.kind}" style="border-color:${lineColor(p.lineId)}">${p.lineId} since t${p.since} ×${p.hits}</span>`)
          .join(' ')
      : '<span class="mono2">∅</span>';
    html += `<tr class="${selectedTick === r.tick ? 'hl' : ''}" data-tick="${r.tick}">
      <td>${r.tick}</td><td>${evs}</td><td>${comp}</td><td>${actionDesc}</td><td>${stack}</td><td>${pend}</td></tr>`;
  }
  html += '</table>';
  els.viewTable.innerHTML = html;
  els.viewTable.querySelectorAll<HTMLElement>('tr[data-tick]').forEach((tr) => {
    tr.addEventListener('click', () => selectTick(Number(tr.dataset.tick)));
  });
}

// ---------- 执行日志 ----------
function renderLogs(): void {
  if (!controller) {
    els.viewLogs.innerHTML = '<p class="hint">载入配置后显示执行日志。</p>';
    return;
  }
  let html = '<table class="records"><tr><th>tick</th><th>类型</th><th>说明</th></tr>';
  for (const log of controller.logs) {
    const cls = log.type;
    html += `<tr class="${selectedTick === log.tick ? 'hl' : ''}" data-tick="${log.tick}">
      <td>${log.tick}</td><td><span class="tag ${cls}">${logZh(log.type)}</span></td>
      <td>${log.detail}</td></tr>`;
  }
  html += '</table>';
  els.viewLogs.innerHTML = html;
  els.viewLogs.querySelectorAll<HTMLElement>('tr[data-tick]').forEach((tr) => {
    tr.addEventListener('click', () => selectTick(Number(tr.dataset.tick)));
  });
}

function eventZh(k: ScheduledEvent['kind']): string {
  switch (k) {
    case 'raise':
      return '触发/拉高';
    case 'lower':
      return '撤销电平';
    case 'mask':
      return '屏蔽';
    case 'unmask':
      return '解除屏蔽';
    case 'setPriority':
      return '调优先级';
    case 'setMode':
      return '切模式';
  }
}
function logZh(t: string): string {
  return (
    { enter: '进入', preempt: '抢占', resume: '恢复', continue: '执行', complete: '完成', event: '事件', idle: '空闲' } as Record<
      string,
      string
    >
  )[t] ?? t;
}

// ---------- 联动选择 ----------
function selectTick(t: number): void {
  selectedTick = t;
  render();
  // 若在表格/日志 tab，把选中行滚入视野。
  const active = document.querySelector<HTMLElement>('.tabs button.active')?.dataset.view;
  const root = active === 'logs' ? els.viewLogs : els.viewTable;
  const row = root.querySelector<HTMLElement>(`tr[data-tick="${t}"]`);
  row?.scrollIntoView({ block: 'nearest' });
}

// ---------- 总渲染 ----------
function render(): void {
  const rec = currentRecord();
  renderState(rec);
  renderTimeline();
  renderTable();
  renderLogs();
  els.trunc.style.display = controller?.isTruncated ? '' : 'none';
  els.trunc.textContent = '⚠ 已达到 500 tick 回放上限，轨迹被截断（仍有未完成工作）。';
  // 未选择具体 tick 时，状态卡跟随最新 tick。
  if (selectedTick > (controller?.ticks.length ?? 0)) selectedTick = controller?.ticks.length ?? 0;
}

// 初次载入第一个演示
fillDemo(0);
loadConfig();

// 暴露到控制台，便于手动用整批回放与逐步推进结果互相核对
(window as unknown as { runReplay: typeof runReplay }).runReplay = runReplay;
