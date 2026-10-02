/**
 * 逐 tick 参考状态机（测试专用，独立于 src/simulator.ts 重新实现同一套语义）。
 *
 * 交叉核对思路：对同一份配置与事件流，参考机每次只推进 1 个 tick（step1），
 * 被测机则用各种不同批次大小推进（advance(1)/advance(3)/一次性 runReplay），
 * 逐 tick 比较归一化后的完整状态快照；再加上手写期望序列核对具体场景。
 */

import { LineConfig, PendingInfo, ScheduledEvent, TickRecord } from '../model.js';

interface RefFrame {
  lineId: string;
  total: number;
  elapsed: number;
  enteredAt: number;
  preempted: boolean;
}

interface RefSnapshot {
  tick: number;
  eventsApplied: TickRecord['eventsApplied'];
  completed?: { lineId: string };
  action: TickRecord['action'];
  stack: RefFrame[];
  pending: PendingInfo[];
  levelAsserted: string[];
  masked: string[];
  topRemaining: number | null;
}

export class ReferenceMachine {
  private cfg: Map<string, LineConfig>;
  private evs: ScheduledEvent[][];
  private t = 0;
  private stack: RefFrame[] = [];
  private pending: PendingInfo[] = [];
  private level = new Set<string>();
  private masked = new Set<string>();
  private running = new Set<string>();

  constructor(lines: LineConfig[], events: ScheduledEvent[]) {
    this.cfg = new Map(lines.map((l) => [l.id, l]));
    const maxT = Math.max(0, ...events.map((e) => e.at));
    this.evs = Array.from({ length: maxT + 1 }, () => []);
    for (const e of events) if (e.at >= 1 && e.at <= maxT) this.evs[e.at].push(e);
    for (const l of lines) if (l.initiallyMasked) this.masked.add(l.id);
  }

  get tick(): number {
    return this.t;
  }

  private pri(id: string): number {
    return this.cfg.get(id)!.priority;
  }

  /** 是否还可能产生记录：栈非空 / 未来有事件 / 存在可运行待处理位。 */
  private alive(): boolean {
    if (this.stack.length) return true;
    for (let i = this.t + 1; i < this.evs.length; i++) if (this.evs[i].length) return true;
    return this.orderedRunnable().length > 0;
  }

  private orderedRunnable(): PendingInfo[] {
    return this.pending
      .filter((p) => !this.masked.has(p.lineId) && !this.running.has(p.lineId))
      .map((p) => ({ ...p }))
      .sort((a, b) =>
        this.pri(a.lineId) !== this.pri(b.lineId)
          ? this.pri(b.lineId) - this.pri(a.lineId)
          : a.since !== b.since
          ? a.since - b.since
          : a.lineId < b.lineId
          ? -1
          : 1
      );
  }

  /** 只推进一个 tick；结束后返回 null。 */
  step1(): RefSnapshot | null {
    if (this.t >= 500 || !this.alive()) return null;
    this.t += 1;
    const tick = this.t;
    const eventsApplied: RefSnapshot['eventsApplied'] = [];

    // ---- 阶段 A：事件（按输入顺序）----
    for (const e of this.evs[tick] ?? []) {
      const cfg = this.cfg.get(e.lineId)!;
      if (cfg.mode === 'edge' && e.kind === 'lower') continue;
      const p = this.pending.find((x) => x.lineId === e.lineId);
      if (e.kind === 'raise') {
        if (cfg.mode === 'edge') {
          if (p) p.hits++;
          else this.pending.push({ lineId: cfg.id, since: tick, hits: 1, kind: 'edge' });
        } else {
          this.level.add(cfg.id);
          if (!this.masked.has(cfg.id) && !this.running.has(cfg.id) && !p) {
            this.pending.push({ lineId: cfg.id, since: tick, hits: 1, kind: 'level' });
          }
        }
      } else if (e.kind === 'lower') {
        this.level.delete(cfg.id);
        if (!this.running.has(cfg.id)) {
          const i = this.pending.findIndex((x) => x.lineId === cfg.id && x.kind === 'level');
          if (i >= 0) this.pending.splice(i, 1);
        }
      } else if (e.kind === 'mask') {
        this.masked.add(cfg.id);
        if (cfg.mode === 'level' && !this.running.has(cfg.id)) {
          const i = this.pending.findIndex((x) => x.lineId === cfg.id && x.kind === 'level');
          if (i >= 0) this.pending.splice(i, 1);
        }
      } else if (e.kind === 'unmask') {
        this.masked.delete(cfg.id);
        if (
          cfg.mode === 'level' &&
          this.level.has(cfg.id) &&
          !this.running.has(cfg.id) &&
          !this.pending.some((x) => x.lineId === cfg.id)
        ) {
          this.pending.push({ lineId: cfg.id, since: tick, hits: 1, kind: 'level' });
        }
      } else if (e.kind === 'setPriority') {
        this.cfg.set(cfg.id, { ...cfg, priority: e.priority! });
      } else if (e.kind === 'setMode') {
        if (e.mode !== cfg.mode) {
          // 真正切换模式：旧模式遗留的待处理位与已记电平一并失效。
          for (let i = this.pending.length - 1; i >= 0; i--) {
            if (this.pending[i].lineId === cfg.id) this.pending.splice(i, 1);
          }
          this.level.delete(cfg.id);
        }
        this.cfg.set(cfg.id, { ...cfg, mode: e.mode! });
      }
      eventsApplied.push(
        e.kind === 'setPriority'
          ? { lineId: e.lineId, kind: e.kind, priority: e.priority }
          : e.kind === 'setMode'
            ? { lineId: e.lineId, kind: e.kind, mode: e.mode }
            : { lineId: e.lineId, kind: e.kind }
      );
    }

    // ---- 阶段 B：上一 tick 的完成 ----
    let completed: RefSnapshot['completed'];
    const top = this.stack[this.stack.length - 1];
    if (top && top.elapsed >= top.total) {
      this.stack.pop();
      this.running.delete(top.lineId);
      completed = { lineId: top.lineId };
      const cfg = this.cfg.get(top.lineId)!;
      if (
        cfg.mode === 'level' &&
        this.level.has(cfg.id) &&
        !this.masked.has(cfg.id) &&
        !this.pending.some((x) => x.lineId === cfg.id)
      ) {
        this.pending.push({ lineId: cfg.id, since: tick, hits: 1, kind: 'level' });
      }
      const parent = this.stack[this.stack.length - 1];
      if (parent) parent.preempted = true;
    }

    // ---- 阶段 C：调度 ----
    const runnable = this.orderedRunnable();
    const win = runnable[0];
    const cur = this.stack[this.stack.length - 1];
    let action: TickRecord['action'];
    if (!cur) {
      if (win) {
        const target = this.pending.find((p2) => p2.lineId === win.lineId)!;
        this.pending.splice(this.pending.indexOf(target), 1);
        this.stack.push({ lineId: win.lineId, total: this.cfg.get(win.lineId)!.handlerTicks, elapsed: 0, enteredAt: tick, preempted: false });
        this.running.add(win.lineId);
        action = { type: 'enter', lineId: win.lineId };
      } else action = { type: 'idle' };
    } else if (win && this.pri(win.lineId) > this.pri(cur.lineId)) {
      cur.preempted = true;
      const target = this.pending.find((p2) => p2.lineId === win.lineId)!;
      this.pending.splice(this.pending.indexOf(target), 1);
      this.stack.push({ lineId: win.lineId, total: this.cfg.get(win.lineId)!.handlerTicks, elapsed: 0, enteredAt: tick, preempted: false });
      this.running.add(win.lineId);
      action = { type: 'preempt', by: win.lineId, resumed: cur.lineId };
    } else if (cur.preempted) {
      action = { type: 'resume', lineId: cur.lineId };
    } else {
      action = { type: 'continue', lineId: cur.lineId };
    }

    // ---- 阶段 D：执行 1 tick ----
    const exec = this.stack[this.stack.length - 1];
    if (exec) {
      exec.elapsed++;
      if (action.type === 'resume') exec.preempted = false;
    }

    return {
      tick,
      eventsApplied,
      completed,
      action,
      stack: this.stack.map((f) => ({ ...f })),
      pending: this.pending
        .map((p) => ({ ...p }))
        .sort((a, b) => (a.since !== b.since ? a.since - b.since : a.lineId < b.lineId ? -1 : 1)),
      levelAsserted: [...this.level].sort(),
      masked: [...this.masked].sort(),
      topRemaining: exec ? exec.total - exec.elapsed : null,
    };
  }
}
