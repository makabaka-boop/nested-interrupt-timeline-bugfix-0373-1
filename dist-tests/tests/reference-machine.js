/**
 * 逐 tick 参考状态机（测试专用，独立于 src/simulator.ts 重新实现同一套语义）。
 *
 * 交叉核对思路：对同一份配置与事件流，参考机每次只推进 1 个 tick（step1），
 * 被测机则用各种不同批次大小推进（advance(1)/advance(3)/一次性 runReplay），
 * 逐 tick 比较归一化后的完整状态快照；再加上手写期望序列核对具体场景。
 *
 * 参考机必须与被测机共享同一套语义定义，尤其是：
 *  - setMode / setPriority 必须真正生效（不能忽略）；
 *  - 待处理位按「来源 origin」解释，模式切换不清空位、不重放历史；
 *  - 栈中帧的抢占门槛在进入时冻结（entryPriority），运行中调级不改变它。
 */
export class ReferenceMachine {
    constructor(lines, events) {
        this.t = 0;
        this.stack = [];
        this.pending = [];
        this.level = new Set();
        this.masked = new Set();
        this.running = new Set();
        this.cfg = new Map(lines.map((l) => [l.id, l]));
        const maxT = Math.max(0, ...events.map((e) => e.at));
        this.evs = Array.from({ length: maxT + 1 }, () => []);
        for (const e of events)
            if (e.at >= 1 && e.at <= maxT)
                this.evs[e.at].push(e);
        for (const l of lines)
            if (l.initiallyMasked)
                this.masked.add(l.id);
    }
    get tick() {
        return this.t;
    }
    pri(id) {
        return this.cfg.get(id).priority;
    }
    /** 是否还可能产生记录：栈非空 / 未来有事件 / 存在可运行待处理位。 */
    alive() {
        if (this.stack.length)
            return true;
        for (let i = this.t + 1; i < this.evs.length; i++)
            if (this.evs[i].length)
                return true;
        return this.orderedRunnable().length > 0;
    }
    orderedRunnable() {
        return this.pending
            .filter((p) => !this.masked.has(p.lineId) && !this.running.has(p.lineId))
            .map((p) => ({ ...p }))
            .sort((a, b) => this.pri(a.lineId) !== this.pri(b.lineId)
            ? this.pri(b.lineId) - this.pri(a.lineId)
            : a.since !== b.since
                ? a.since - b.since
                : a.lineId < b.lineId
                    ? -1
                    : 1);
    }
    /** 阶段 A：应用单个事件（与 simulator.ts 的 applyEvent 语义一致）。 */
    apply(e, tick) {
        const cfg = this.cfg.get(e.lineId);
        const p = this.pending.find((x) => x.lineId === e.lineId);
        switch (e.kind) {
            case 'raise': {
                if (cfg.mode === 'edge') {
                    if (p)
                        p.hits += 1;
                    else
                        this.pending.push({ lineId: cfg.id, since: tick, hits: 1, origin: 'edge' });
                }
                else {
                    this.level.add(cfg.id);
                    if (!this.masked.has(cfg.id) && !this.running.has(cfg.id) && !p) {
                        this.pending.push({ lineId: cfg.id, since: tick, hits: 1, origin: 'level' });
                    }
                }
                break;
            }
            case 'lower': {
                if (cfg.mode === 'level') {
                    this.level.delete(cfg.id);
                    if (!this.running.has(cfg.id)) {
                        const i = this.pending.findIndex((x) => x.lineId === cfg.id && x.origin === 'level');
                        if (i >= 0)
                            this.pending.splice(i, 1);
                    }
                }
                break;
            }
            case 'mask': {
                this.masked.add(cfg.id);
                if (cfg.mode === 'level' && !this.running.has(cfg.id)) {
                    const i = this.pending.findIndex((x) => x.lineId === cfg.id && x.origin === 'level');
                    if (i >= 0)
                        this.pending.splice(i, 1);
                }
                break;
            }
            case 'unmask': {
                this.masked.delete(cfg.id);
                if (cfg.mode === 'level' &&
                    this.level.has(cfg.id) &&
                    !this.running.has(cfg.id) &&
                    !this.pending.some((x) => x.lineId === cfg.id)) {
                    this.pending.push({ lineId: cfg.id, since: tick, hits: 1, origin: 'level' });
                }
                break;
            }
            case 'setPriority': {
                // 只影响后续调度；栈中帧门槛已冻结，不在这里改动。
                this.cfg.set(cfg.id, { ...cfg, priority: e.priority });
                break;
            }
            case 'setMode': {
                // 不清空位、不重放历史；origin 保留，物理电平保留。
                this.cfg.set(cfg.id, { ...cfg, mode: e.mode });
                break;
            }
        }
    }
    enter(id, tick) {
        const cfg = this.cfg.get(id);
        const target = this.pending.find((p2) => p2.lineId === id);
        this.pending.splice(this.pending.indexOf(target), 1);
        this.stack.push({
            lineId: id,
            total: cfg.handlerTicks,
            elapsed: 0,
            enteredAt: tick,
            entryPriority: cfg.priority,
            entryMode: cfg.mode,
            preempted: false,
        });
        this.running.add(id);
    }
    /** 只推进一个 tick；结束后返回 null。 */
    step1() {
        if (this.t >= 500 || !this.alive())
            return null;
        this.t += 1;
        const tick = this.t;
        const eventsApplied = [];
        // ---- 阶段 A：事件（按输入顺序）----
        for (const e of this.evs[tick] ?? []) {
            const cfg = this.cfg.get(e.lineId);
            if (cfg.mode === 'edge' && e.kind === 'lower')
                continue;
            this.apply(e, tick);
            eventsApplied.push(e.kind === 'setPriority'
                ? { lineId: e.lineId, kind: e.kind, priority: e.priority }
                : e.kind === 'setMode'
                    ? { lineId: e.lineId, kind: e.kind, mode: e.mode }
                    : { lineId: e.lineId, kind: e.kind });
        }
        // ---- 阶段 B：上一 tick 的完成 ----
        let completed;
        const top = this.stack[this.stack.length - 1];
        if (top && top.elapsed >= top.total) {
            this.stack.pop();
            this.running.delete(top.lineId);
            completed = { lineId: top.lineId };
            const cfg = this.cfg.get(top.lineId);
            if (cfg.mode === 'level' &&
                this.level.has(cfg.id) &&
                !this.masked.has(cfg.id) &&
                !this.pending.some((x) => x.lineId === cfg.id)) {
                this.pending.push({ lineId: cfg.id, since: tick, hits: 1, origin: 'level' });
            }
            const parent = this.stack[this.stack.length - 1];
            if (parent)
                parent.preempted = true;
        }
        // ---- 阶段 C：调度（等待者用当前优先级，帧门槛用进入时冻结值）----
        const runnable = this.orderedRunnable();
        const win = runnable[0];
        const cur = this.stack[this.stack.length - 1];
        let action;
        if (!cur) {
            if (win) {
                this.enter(win.lineId, tick);
                action = { type: 'enter', lineId: win.lineId };
            }
            else
                action = { type: 'idle' };
        }
        else if (win && this.pri(win.lineId) > cur.entryPriority) {
            cur.preempted = true;
            this.enter(win.lineId, tick);
            action = { type: 'preempt', by: win.lineId, resumed: cur.lineId };
        }
        else if (cur.preempted) {
            action = { type: 'resume', lineId: cur.lineId };
        }
        else {
            action = { type: 'continue', lineId: cur.lineId };
        }
        // ---- 阶段 D：执行 1 tick ----
        const exec = this.stack[this.stack.length - 1];
        if (exec) {
            exec.elapsed++;
            if (action.type === 'resume')
                exec.preempted = false;
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
            lineStates: [...this.cfg.values()]
                .map((l) => ({ lineId: l.id, priority: l.priority, mode: l.mode }))
                .sort((a, b) => (a.lineId < b.lineId ? -1 : a.lineId > b.lineId ? 1 : 0)),
            topRemaining: exec ? exec.total - exec.elapsed : null,
        };
    }
}
