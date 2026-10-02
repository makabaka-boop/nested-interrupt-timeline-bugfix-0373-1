/**
 * 中断控制器回放核心（不连接真实硬件）。
 *
 * 每个 tick 的固定顺序：
 *   阶段 A：应用该 tick 的外部事件（同一 tick 多事件严格按输入顺序生效）
 *   阶段 B：处理「上一 tick」执行到最后一个 tick 的处理程序完成
 *   阶段 C：调度 —— 栈空时取优先级最高的可运行待处理线进入；
 *           栈非空时，仅严格更高优先级的待处理线可抢占，
 *           同优先级按待处理时刻(since)、ID 排队等待。
 *   阶段 D：栈顶处理程序执行 1 tick（被抢占者此 tick 不消耗 handlerTicks）。
 *
 * 抢占门槛：
 *  - 等待者始终按「当前」优先级参与排序；
 *  - 栈中帧的抢占门槛在进入时冻结（FrameInfo.entryPriority），运行期间
 *    setPriority 不会改变它，也不会让等待线在调级当 tick 抢占（处理程序
 *    一旦开始就跑到让出点：完成或被真正更高优先级的新等待者抢占）。
 *
 * 待处理位语义（按「来源 origin」而非「当前模式」解释）：
 *  - edge 来源（含切到电平后保留下来的旧边沿位）：一次性位，屏蔽期保留、
 *    重复触发合并（hits 累加）；只能被调度消费，lower 对它无效。
 *  - level 来源：由当前物理电平派生；电平撤销(lower)或屏蔽(mask)即移除，
 *    处理完成时电平仍有效则重新置位（电平重入）。
 *
 * 模式切换（setMode）不重放历史、不合成边沿，也不清空已有待处理位：
 *  - edge→level：旧 edge 位保留（仍会被执行一次）；物理电平不变。
 *  - level→edge：由电平派生的 level 位保留为一次性位；物理电平不变，
 *    此后只有新的 raise 边沿才会再置位。
 *
 * 屏蔽正在运行的线不会停止其当前处理程序；屏蔽只影响后续调度资格。
 */

import {
  comparePending,
  FrameInfo,
  LineConfig,
  MAX_TICKS,
  PendingInfo,
  ScheduledEvent,
  TickRecord,
  Trace,
  TraceLog,
} from './model.js';

/** 校验配置与事件，返回告警/错误。 */
export function validateInput(
  lines: LineConfig[],
  events: ScheduledEvent[]
): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (lines.length < 1 || lines.length > 8) {
    errors.push(`中断线数量必须在 1～8 之间，当前为 ${lines.length} 条。`);
  }
  const ids = new Set<string>();
  for (const ln of lines) {
    if (!ln.id || !ln.id.trim()) errors.push('存在空 ID 的中断线。');
    if (ids.has(ln.id)) errors.push(`中断线 ID 重复：${ln.id}`);
    ids.add(ln.id);
    if (!Number.isInteger(ln.priority)) errors.push(`线 ${ln.id} 的优先级必须是整数。`);
    if (!Number.isInteger(ln.handlerTicks) || ln.handlerTicks < 1) {
      errors.push(`线 ${ln.id} 的 handlerTicks 必须是 >= 1 的整数。`);
    }
    if (ln.mode !== 'edge' && ln.mode !== 'level') {
      errors.push(`线 ${ln.id} 的模式必须是 edge 或 level。`);
    }
  }
  for (const ev of events) {
    if (!ids.has(ev.lineId)) {
      errors.push(`tick ${ev.at} 的事件引用了不存在的线：${ev.lineId}`);
    }
    if (!Number.isInteger(ev.at) || ev.at < 1) {
      errors.push(`线 ${ev.lineId} 存在非法 tick（需为 >= 1 的整数）：${ev.at}`);
    }
    if (ev.at > MAX_TICKS) {
      warnings.push(`tick ${ev.at} 超出 ${MAX_TICKS} tick 回放窗口，该事件永远不会被应用。`);
    }
    if (ev.kind === 'setPriority' && !Number.isInteger(ev.priority)) {
      errors.push(`tick ${ev.at} 的优先级调整缺少整数 priority：${ev.lineId}`);
    }
    if (ev.kind === 'setMode' && ev.mode !== 'edge' && ev.mode !== 'level') {
      errors.push(`tick ${ev.at} 的模式调整必须指定 edge 或 level：${ev.lineId}`);
    }
  }
  // lower 是否有意义取决于「事件发生当 tick（阶段 A 应用时）的当前模式」，
  // 因此按 tick 与输入顺序模拟一遍模式变化来给告警，而不是只看初始模式。
  const modeAt = new Map(lines.map((l) => [l.id, l.mode]));
  const byTick = new Map<number, ScheduledEvent[]>();
  for (const ev of events) {
    const list = byTick.get(ev.at) ?? [];
    list.push(ev);
    byTick.set(ev.at, list);
  }
  for (const t of [...byTick.keys()].sort((a, b) => a - b)) {
    for (const ev of byTick.get(t)!) {
      if (ev.kind === 'setMode' && (ev.mode === 'edge' || ev.mode === 'level')) {
        modeAt.set(ev.lineId, ev.mode);
      } else if (ev.kind === 'lower' && modeAt.get(ev.lineId) === 'edge') {
        warnings.push(`tick ${ev.at}：线 ${ev.lineId} 当前为边沿模式，lower 事件无意义，已忽略。`);
      }
    }
  }
  return { errors, warnings };
}

interface InternalState {
  cfg: Map<string, LineConfig>;
  /** 待处理位：origin=edge 的一次性位 / origin=level 的电平派站位。 */
  pending: PendingInfo[];
  /** 当前物理输入电平为高的线（与当前模式无关，切模式不改变它）。 */
  levelAsserted: Set<string>;
  masked: Set<string>;
  /** 执行栈，栈顶在数组末尾。 */
  stack: FrameInfo[];
  /** 栈中是否已有同线帧（一条线的处理程序不可与自身并发）。 */
  runningIds: Set<string>;
}

/** 逐 tick 推进器：同一状态机既支持单步也支持整批回放。 */
export class ReplayController {
  private state: InternalState;
  private eventsByTick: Map<number, ScheduledEvent[]>;
  private lastTick = 0;
  private truncated = false;
  readonly logs: TraceLog[] = [];
  readonly ticks: TickRecord[] = [];
  readonly warnings: string[];

  constructor(lines: LineConfig[], events: ScheduledEvent[], warnings: string[] = []) {
    this.state = {
      cfg: new Map(lines.map((l) => [l.id, l])),
      pending: [],
      levelAsserted: new Set(),
      masked: new Set(lines.filter((l) => l.initiallyMasked).map((l) => l.id)),
      stack: [],
      runningIds: new Set(),
    };
    this.eventsByTick = new Map();
    for (const ev of events) {
      const list = this.eventsByTick.get(ev.at) ?? [];
      list.push(ev);
      this.eventsByTick.set(ev.at, list);
    }
    this.warnings = warnings;
  }

  get currentTick(): number {
    return this.lastTick;
  }

  get isTruncated(): boolean {
    return this.truncated;
  }

  /** 是否还有工作（未来事件 / 执行栈 / 可运行待处理位）。 */
  private hasWorkAfter(tick: number): boolean {
    if (this.state.stack.length > 0) return true;
    for (const key of this.eventsByTick.keys()) {
      if (key > tick) return true;
    }
    return this.runnablePending().length > 0;
  }

  /** 推进一个 tick；没有任何剩余工作时返回 null。 */
  step(): TickRecord | null {
    if (this.lastTick >= MAX_TICKS) {
      this.truncated = this.hasWorkAfter(this.lastTick);
      return null;
    }
    if (!this.hasWorkAfter(this.lastTick)) return null;
    const tick = this.lastTick + 1;
    const rec = this.runTick(tick);
    this.lastTick = tick;
    this.ticks.push(rec);
    return rec;
  }

  /** 一次推进 n 个 tick（用于测试「不同批次推进」与逐 tick 完全一致）。 */
  advance(n: number): TickRecord[] {
    const out: TickRecord[] = [];
    for (let i = 0; i < n; i++) {
      const rec = this.step();
      if (!rec) break;
      out.push(rec);
    }
    return out;
  }

  toTrace(): Trace {
    return { ticks: this.ticks, logs: this.logs, truncated: this.truncated, warnings: this.warnings };
  }

  // ------------------------------------------------------------------
  // 阶段 A：事件
  // ------------------------------------------------------------------

  private applyEvent(ev: ScheduledEvent, tick: number): void {
    const { cfg, pending, levelAsserted, masked, runningIds } = this.state;
    const line = cfg.get(ev.lineId)!;
    const existing = pending.find((p) => p.lineId === ev.lineId);

    switch (ev.kind) {
      case 'raise': {
        if (line.mode === 'edge') {
          // 边沿触发：无论屏蔽、空闲还是本线正在运行，尚未消费期间重复触发
          // 都合并为一位（edge 来源），hits 累加并保留最早 since。
          if (existing) {
            existing.hits += 1;
          } else {
            pending.push({ lineId: line.id, since: tick, hits: 1, origin: 'edge' });
          }
        } else {
          // 电平拉高：记录物理电平；未屏蔽且未运行时派生一个 level 位。
          // 屏蔽 / 正在运行都不丢失物理电平。
          levelAsserted.add(line.id);
          if (!masked.has(line.id) && !runningIds.has(line.id) && !existing) {
            pending.push({ lineId: line.id, since: tick, hits: 1, origin: 'level' });
          }
        }
        break;
      }
      case 'lower': {
        if (line.mode === 'level') {
          // 撤销物理电平：只移除由电平派生（origin=level）的待处理位；
          // 切到电平后保留下来的旧 edge 一次性位不受 lower 影响。
          levelAsserted.delete(line.id);
          if (!runningIds.has(line.id)) {
            const idx = pending.findIndex((p) => p.lineId === line.id && p.origin === 'level');
            if (idx >= 0) pending.splice(idx, 1);
          }
        }
        // edge 模式的 lower 在 validateInput 中已作为告警，这里直接忽略。
        break;
      }
      case 'mask': {
        masked.add(line.id);
        // 屏蔽只撤销「电平派生」位的调度资格（物理电平保留，解除时可恢复）；
        // edge 一次性位（含切模式遗留的旧位）在屏蔽期间保留。
        if (line.mode === 'level' && !runningIds.has(line.id)) {
          const idx = pending.findIndex((p) => p.lineId === line.id && p.origin === 'level');
          if (idx >= 0) pending.splice(idx, 1);
        }
        break;
      }
      case 'unmask': {
        masked.delete(line.id);
        // 解除屏蔽不合成边沿；但若物理电平仍有效且当前是电平模式，
        // 立即重新派生 level 位（since 取解除屏蔽的当前 tick）。
        if (
          line.mode === 'level' &&
          levelAsserted.has(line.id) &&
          !runningIds.has(line.id) &&
          !pending.some((p) => p.lineId === line.id)
        ) {
          pending.push({ lineId: line.id, since: tick, hits: 1, origin: 'level' });
        }
        break;
      }
      case 'setPriority': {
        // 仅影响后续调度：等待者按新优先级排序；已在栈中的帧门槛已冻结。
        cfg.set(line.id, { ...line, priority: ev.priority! });
        break;
      }
      case 'setMode': {
        // 切换触发模式：不重放历史、不合成边沿，也不清空已有待处理位。
        // 待处理位的 origin 保留（旧 edge 位仍执行一次；旧 level 位变为
        // 一次性位）；物理电平保持不变。
        cfg.set(line.id, { ...line, mode: ev.mode! });
        break;
      }
    }
  }

  // ------------------------------------------------------------------
  // 调度辅助
  // ------------------------------------------------------------------

  /** 当前有资格被调度的待处理位（未屏蔽、未在栈中），按调度顺序排序。 */
  private runnablePending(): PendingInfo[] {
    const { masked, runningIds } = this.state;
    return this.state.pending
      .filter((p) => !masked.has(p.lineId) && !runningIds.has(p.lineId))
      .sort((a, b) => {
        // 主排序：优先级高者先；次排序：置位时刻、ID（同优先级等待规则）。
        const pa = this.state.cfg.get(a.lineId)!.priority;
        const pb = this.state.cfg.get(b.lineId)!.priority;
        if (pa !== pb) return pb - pa;
        return comparePending(a, b);
      });
  }

  // ------------------------------------------------------------------
  // 单 tick
  // ------------------------------------------------------------------

  private runTick(tick: number): TickRecord {
    const eventsApplied: Array<{ lineId: string; kind: ScheduledEvent['kind']; priority?: number; mode?: LineConfig['mode'] }> = [];
    let completed: { lineId: string } | undefined;

    // 阶段 A：应用事件（同一 tick 多事件按输入顺序）。
    for (const ev of this.eventsByTick.get(tick) ?? []) {
      const cfg = this.state.cfg.get(ev.lineId);
      if (!cfg) continue;
      if (cfg.mode === 'edge' && ev.kind === 'lower') continue;
      this.applyEvent(ev, tick);
      eventsApplied.push(ev.kind === 'setPriority'
        ? { lineId: ev.lineId, kind: ev.kind, priority: ev.priority }
        : ev.kind === 'setMode'
          ? { lineId: ev.lineId, kind: ev.kind, mode: ev.mode }
          : { lineId: ev.lineId, kind: ev.kind });
      this.logs.push({
        tick,
        type: 'event',
        lineId: ev.lineId,
        eventKind: ev.kind,
        detail:
          `tick ${tick} 事件：${ev.lineId} ${eventLabel(ev.kind)}` +
          (ev.kind === 'setPriority' ? ` ${ev.priority}` : '') +
          (ev.kind === 'setMode' ? ` ${ev.mode}` : ''),
      });
    }

    // 阶段 B：处理上一 tick 的完成（栈顶 elapsed 已达 total）。
    const top = this.state.stack[this.state.stack.length - 1];
    if (top && top.elapsed >= top.total) {
      this.state.stack.pop()!;
      this.state.runningIds.delete(top.lineId);
      completed = { lineId: top.lineId };
      this.logs.push({
        tick,
        type: 'complete',
        lineId: top.lineId,
        detail: `tick ${tick} 完成：${top.lineId}（共 ${top.total} tick）`,
      });

      // 完成后：仅当「当前」仍是电平模式且物理电平仍有效（且未屏蔽）时，
      // 才重新派生 level 位（电平重入）。若运行期间已切成边沿，则物理电平
      // 不会重放为边沿，不再重入。
      const cfg = this.state.cfg.get(top.lineId)!;
      if (
        cfg.mode === 'level' &&
        this.state.levelAsserted.has(top.lineId) &&
        !this.state.masked.has(top.lineId) &&
        !this.state.pending.some((p) => p.lineId === top.lineId)
      ) {
        this.state.pending.push({ lineId: top.lineId, since: tick, hits: 1, origin: 'level' });
      }

      // 露出的父帧标记为「抢占结束」，本 tick 稍后可能 resume。
      const parent = this.state.stack[this.state.stack.length - 1];
      if (parent) parent.preempted = true;
    }

    // 阶段 C：抢占 / 调度。
    const runnable = this.runnablePending();
    const winner = runnable[0];
    let action: TickRecord['action'];
    const currentTop = this.state.stack[this.state.stack.length - 1];

    if (!currentTop) {
      // 栈空：取优先级最高的可运行待处理线进入。
      if (winner) {
        this.enterFrame(winner, tick);
        action = { type: 'enter', lineId: winner.lineId };
      } else {
        action = { type: 'idle' };
      }
    } else if (
      winner &&
      this.state.cfg.get(winner.lineId)!.priority > currentTop.entryPriority
    ) {
      // 仅严格高于「该帧进入时冻结的门槛」才可抢占；运行中调级不改变门槛，
      // 故调级当 tick（及之后）都不会让等待者借此抢占。同优先级继续等待。
      currentTop.preempted = true;
      this.enterFrame(winner, tick);
      action = { type: 'preempt', by: winner.lineId, resumed: currentTop.lineId };
      this.logs.push({
        tick,
        type: 'preempt',
        lineId: winner.lineId,
        detail: `tick ${tick} 抢占：${winner.lineId}（当前优先级 ${
          this.state.cfg.get(winner.lineId)!.priority
        }）抢占 ${currentTop.lineId}（进入门槛 p${currentTop.entryPriority}；` +
          `当前 p${this.state.cfg.get(currentTop.lineId)!.priority} 不改变门槛），同优先级候选继续等待`,
      });
    } else if (currentTop.preempted) {
      // 抢占者已完成、露出的父帧本 tick 恢复（无更高优先级再抢占）。
      action = { type: 'resume', lineId: currentTop.lineId };
    } else {
      action = { type: 'continue', lineId: currentTop.lineId };
    }

    // 阶段 D：栈顶执行 1 tick（刚进入的帧也算第 1 个执行 tick；
    // 被抢占而挂起的帧此 tick 不执行、不消耗 handlerTicks）。
    const execTop = this.state.stack[this.state.stack.length - 1];
    if (execTop) {
      execTop.elapsed += 1;
      if (action.type === 'enter') {
        this.logs.push({
          tick,
          type: 'enter',
          lineId: execTop.lineId,
          detail: `tick ${tick} 进入：${execTop.lineId}（需要 ${execTop.total} tick）`,
        });
      } else if (action.type === 'preempt') {
        this.logs.push({
          tick,
          type: 'enter',
          lineId: execTop.lineId,
          detail: `tick ${tick} 进入：${execTop.lineId}（抢占进入，需要 ${execTop.total} tick）`,
        });
      } else if (action.type === 'resume') {
        this.logs.push({
          tick,
          type: 'resume',
          lineId: execTop.lineId,
          detail: `tick ${tick} 恢复：${execTop.lineId}（已执行 ${execTop.elapsed}/${execTop.total}）`,
        });
        // 恢复并执行一个 tick 后，抢占痕迹消费完毕，此后按 continue 记录。
        execTop.preempted = false;
      } else if (action.type === 'continue') {
        this.logs.push({
          tick,
          type: 'continue',
          lineId: execTop.lineId,
          detail: `tick ${tick} 执行：${execTop.lineId}（已执行 ${execTop.elapsed}/${execTop.total}）`,
        });
      }
    }

    return {
      tick,
      eventsApplied,
      completed,
      action,
      stack: this.state.stack.map((f) => ({ ...f })),
      pending: this.state.pending.slice().sort(comparePending).map((p) => ({ ...p })),
      levelAsserted: [...this.state.levelAsserted].sort(),
      masked: [...this.state.masked].sort(),
      lineStates: [...this.state.cfg.values()]
        .map((l) => ({ lineId: l.id, priority: l.priority, mode: l.mode }))
        .sort((a, b) => (a.lineId < b.lineId ? -1 : a.lineId > b.lineId ? 1 : 0)),
      topRemaining: execTop ? execTop.total - execTop.elapsed : null,
    };
  }

  private enterFrame(p: PendingInfo, tick: number): void {
    const cfg = this.state.cfg.get(p.lineId)!;
    this.state.pending = this.state.pending.filter((x) => x !== p);
    this.state.stack.push({
      lineId: p.lineId,
      total: cfg.handlerTicks,
      elapsed: 0,
      enteredAt: tick,
      // 抢占门槛与模式在进入时冻结，运行中 setPriority/setMode 不影响本帧。
      entryPriority: cfg.priority,
      entryMode: cfg.mode,
      preempted: false,
    });
    this.state.runningIds.add(p.lineId);
  }
}

function eventLabel(kind: ScheduledEvent['kind']): string {
  switch (kind) {
    case 'raise':
      return 'raise（触发/拉高）';
    case 'lower':
      return 'lower（撤销电平）';
    case 'mask':
      return 'mask（屏蔽）';
    case 'unmask':
      return 'unmask（解除屏蔽）';
    case 'setPriority':
      return 'setPriority（调整优先级）';
    case 'setMode':
      return 'setMode（切换触发模式）';
    default:
      return kind;
  }
}
/** 整批回放：推进到无剩余工作或达到 500 tick 上限。 */
export function runReplay(lines: LineConfig[], events: ScheduledEvent[]): Trace {
  const { errors, warnings } = validateInput(lines, events);
  if (errors.length > 0) {
    throw new Error('配置无效：\n' + errors.map((e) => ' - ' + e).join('\n'));
  }
  const ctrl = new ReplayController(lines, events, warnings);
  while (ctrl.step() !== null) {
    // 逐 tick 推进，直到空闲且无未来事件，或触顶 500。
  }
  return ctrl.toTrace();
}
