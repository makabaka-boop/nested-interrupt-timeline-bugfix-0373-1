/**
 * 中断控制器回放核心（不连接真实硬件）。
 *
 * 每个 tick 的固定顺序：
 *   阶段 A：应用该 tick 的外部事件（raise / lower / mask / unmask）
 *   阶段 B：处理「上一 tick」执行到最后一个 tick 的处理程序完成
 *   阶段 C：调度 —— 栈空时取优先级最高的可运行待处理线进入；
 *           栈非空时，仅严格更高优先级的待处理线可抢占，
 *           同优先级按待处理时刻(since)、ID 排队等待。
 *   阶段 D：栈顶处理程序执行 1 tick（被抢占者此 tick 不消耗 handlerTicks）。
 *
 * 语义要点：
 *  - 边沿线：屏蔽期间置起的待处理位保留，重复触发合并（hits 累加）；
 *    处理程序运行期间再次触发也会置一个待处理位（可嵌套重入）。
 *  - 电平线：输入保持有效且未屏蔽时即为可运行；处理完成后电平仍有效
 *    则再次进入；屏蔽只阻止调度，不撤销输入电平。
 *  - 屏蔽正在运行的线不会停止其当前处理程序；屏蔽只影响调度资格。
 */
import { comparePending, MAX_TICKS, } from './model.js';
/** 校验配置与事件，返回告警/错误。 */
export function validateInput(lines, events) {
    const errors = [];
    const warnings = [];
    if (lines.length < 1 || lines.length > 8) {
        errors.push(`中断线数量必须在 1～8 之间，当前为 ${lines.length} 条。`);
    }
    const ids = new Set();
    for (const ln of lines) {
        if (!ln.id || !ln.id.trim())
            errors.push('存在空 ID 的中断线。');
        if (ids.has(ln.id))
            errors.push(`中断线 ID 重复：${ln.id}`);
        ids.add(ln.id);
        if (!Number.isInteger(ln.priority))
            errors.push(`线 ${ln.id} 的优先级必须是整数。`);
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
        const cfg = lines.find((l) => l.id === ev.lineId);
        if (cfg?.mode === 'edge' && ev.kind === 'lower') {
            warnings.push(`tick ${ev.at}：边沿线 ${ev.lineId} 的 lower 事件无意义，已忽略。`);
        }
    }
    return { errors, warnings };
}
/** 逐 tick 推进器：同一状态机既支持单步也支持整批回放。 */
export class ReplayController {
    constructor(lines, events, warnings = []) {
        this.lastTick = 0;
        this.truncated = false;
        this.logs = [];
        this.ticks = [];
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
    get currentTick() {
        return this.lastTick;
    }
    get isTruncated() {
        return this.truncated;
    }
    /** 是否还有工作（未来事件 / 执行栈 / 可运行待处理位）。 */
    hasWorkAfter(tick) {
        if (this.state.stack.length > 0)
            return true;
        for (const key of this.eventsByTick.keys()) {
            if (key > tick)
                return true;
        }
        return this.runnablePending().length > 0;
    }
    /** 推进一个 tick；没有任何剩余工作时返回 null。 */
    step() {
        if (this.lastTick >= MAX_TICKS) {
            this.truncated = this.hasWorkAfter(this.lastTick);
            return null;
        }
        if (!this.hasWorkAfter(this.lastTick))
            return null;
        const tick = this.lastTick + 1;
        const rec = this.runTick(tick);
        this.lastTick = tick;
        this.ticks.push(rec);
        return rec;
    }
    /** 一次推进 n 个 tick（用于测试「不同批次推进」与逐 tick 完全一致）。 */
    advance(n) {
        const out = [];
        for (let i = 0; i < n; i++) {
            const rec = this.step();
            if (!rec)
                break;
            out.push(rec);
        }
        return out;
    }
    toTrace() {
        return { ticks: this.ticks, logs: this.logs, truncated: this.truncated, warnings: this.warnings };
    }
    // ------------------------------------------------------------------
    // 阶段 A：事件
    // ------------------------------------------------------------------
    applyEvent(ev, tick) {
        const { cfg, pending, levelAsserted, masked, runningIds } = this.state;
        const line = cfg.get(ev.lineId);
        const existing = pending.find((p) => p.lineId === ev.lineId);
        switch (ev.kind) {
            case 'raise': {
                if (line.mode === 'edge') {
                    // 边沿：待处理位尚未被调度消费时（无论屏蔽、空闲还是本线正在运行），
                    // 重复触发都合并为一位，hits 累加并保留最早 since。
                    if (existing) {
                        existing.hits += 1;
                    }
                    else {
                        pending.push({ lineId: line.id, since: tick, hits: 1, kind: 'edge' });
                    }
                }
                else {
                    // 电平：置高输入。屏蔽 / 正在运行都不丢失输入状态，
                    // 但只有未屏蔽且未运行时才立即可调度。
                    levelAsserted.add(line.id);
                    if (!masked.has(line.id) && !runningIds.has(line.id) && !existing) {
                        pending.push({ lineId: line.id, since: tick, hits: 1, kind: 'level' });
                    }
                }
                break;
            }
            case 'lower': {
                if (line.mode === 'level') {
                    levelAsserted.delete(line.id);
                    // 还没被调度消费的 level 待处理位随撤销而消失；
                    // 已在执行栈中的处理程序不受影响（屏蔽/撤销不杀正在运行的程序）。
                    if (!runningIds.has(line.id)) {
                        const idx = pending.findIndex((p) => p.lineId === line.id && p.kind === 'level');
                        if (idx >= 0)
                            pending.splice(idx, 1);
                    }
                }
                // edge 线的 lower 在 validateInput 中已作为告警，这里直接忽略。
                break;
            }
            case 'mask': {
                masked.add(line.id);
                // 电平位被屏蔽后立即失去调度资格并移出待处理集合，
                // 输入电平本身不撤销（解除屏蔽时若仍有效会重新置位）。
                if (line.mode === 'level' && !runningIds.has(line.id)) {
                    const idx = pending.findIndex((p) => p.lineId === line.id && p.kind === 'level');
                    if (idx >= 0)
                        pending.splice(idx, 1);
                }
                // 边沿位按需求在屏蔽期间保留（重复触发继续合并），不动 pending。
                break;
            }
            case 'unmask': {
                masked.delete(line.id);
                // 解除屏蔽不会合成边沿；但仍有效的电平线立即恢复可调度，
                // since 取「当前可运行」的时刻（解除屏蔽的时刻）。
                if (line.mode === 'level' &&
                    levelAsserted.has(line.id) &&
                    !runningIds.has(line.id) &&
                    !pending.some((p) => p.lineId === line.id)) {
                    pending.push({ lineId: line.id, since: tick, hits: 1, kind: 'level' });
                }
                break;
            }
        }
    }
    // ------------------------------------------------------------------
    // 调度辅助
    // ------------------------------------------------------------------
    /** 当前有资格被调度的待处理位（未屏蔽、未在栈中），按调度顺序排序。 */
    runnablePending() {
        const { masked, runningIds } = this.state;
        return this.state.pending
            .filter((p) => !masked.has(p.lineId) && !runningIds.has(p.lineId))
            .sort((a, b) => {
            // 主排序：优先级高者先；次排序：置位时刻、ID（同优先级等待规则）。
            const pa = this.state.cfg.get(a.lineId).priority;
            const pb = this.state.cfg.get(b.lineId).priority;
            if (pa !== pb)
                return pb - pa;
            return comparePending(a, b);
        });
    }
    // ------------------------------------------------------------------
    // 单 tick
    // ------------------------------------------------------------------
    runTick(tick) {
        const eventsApplied = [];
        let completed;
        // 阶段 A：应用事件（同一 tick 多事件按输入顺序）。
        for (const ev of this.eventsByTick.get(tick) ?? []) {
            const cfg = this.state.cfg.get(ev.lineId);
            if (!cfg)
                continue;
            if (cfg.mode === 'edge' && ev.kind === 'lower')
                continue;
            this.applyEvent(ev, tick);
            eventsApplied.push({ lineId: ev.lineId, kind: ev.kind });
            this.logs.push({
                tick,
                type: 'event',
                lineId: ev.lineId,
                eventKind: ev.kind,
                detail: `tick ${tick} 事件：${ev.lineId} ${eventLabel(ev.kind)}`,
            });
        }
        // 阶段 B：处理上一 tick 的完成（栈顶 elapsed 已达 total）。
        const top = this.state.stack[this.state.stack.length - 1];
        if (top && top.elapsed >= top.total) {
            this.state.stack.pop();
            this.state.runningIds.delete(top.lineId);
            completed = { lineId: top.lineId };
            this.logs.push({
                tick,
                type: 'complete',
                lineId: top.lineId,
                detail: `tick ${tick} 完成：${top.lineId}（共 ${top.total} tick）`,
            });
            // 完成后：电平仍有效 → 重新成为可运行待处理位（电平重入）。
            const cfg = this.state.cfg.get(top.lineId);
            if (cfg.mode === 'level' &&
                this.state.levelAsserted.has(top.lineId) &&
                !this.state.masked.has(top.lineId) &&
                !this.state.pending.some((p) => p.lineId === top.lineId)) {
                this.state.pending.push({ lineId: top.lineId, since: tick, hits: 1, kind: 'level' });
            }
            // 露出的父帧标记为「抢占结束」，本 tick 稍后可能 resume。
            const parent = this.state.stack[this.state.stack.length - 1];
            if (parent)
                parent.preempted = true;
        }
        // 阶段 C：抢占 / 调度。
        const runnable = this.runnablePending();
        const winner = runnable[0];
        let action;
        const currentTop = this.state.stack[this.state.stack.length - 1];
        if (!currentTop) {
            // 栈空：取优先级最高的可运行待处理线进入。
            if (winner) {
                this.enterFrame(winner, tick);
                action = { type: 'enter', lineId: winner.lineId };
            }
            else {
                action = { type: 'idle' };
            }
        }
        else if (winner &&
            this.state.cfg.get(winner.lineId).priority >
                this.state.cfg.get(currentTop.lineId).priority) {
            // 仅严格更高优先级可抢占当前程序；同优先级即使等待也不动。
            currentTop.preempted = true;
            this.enterFrame(winner, tick);
            action = { type: 'preempt', by: winner.lineId, resumed: currentTop.lineId };
            this.logs.push({
                tick,
                type: 'preempt',
                lineId: winner.lineId,
                detail: `tick ${tick} 抢占：${winner.lineId}（优先级 ${this.state.cfg.get(winner.lineId).priority}）抢占 ${currentTop.lineId}（优先级 ${this.state.cfg.get(currentTop.lineId).priority}），同优先级候选继续等待`,
            });
        }
        else if (currentTop.preempted) {
            // 抢占者已完成、露出的父帧本 tick 恢复（无更高优先级再抢占）。
            action = { type: 'resume', lineId: currentTop.lineId };
        }
        else {
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
            }
            else if (action.type === 'preempt') {
                this.logs.push({
                    tick,
                    type: 'enter',
                    lineId: execTop.lineId,
                    detail: `tick ${tick} 进入：${execTop.lineId}（抢占进入，需要 ${execTop.total} tick）`,
                });
            }
            else if (action.type === 'resume') {
                this.logs.push({
                    tick,
                    type: 'resume',
                    lineId: execTop.lineId,
                    detail: `tick ${tick} 恢复：${execTop.lineId}（已执行 ${execTop.elapsed}/${execTop.total}）`,
                });
                // 恢复并执行一个 tick 后，抢占痕迹消费完毕，此后按 continue 记录。
                execTop.preempted = false;
            }
            else if (action.type === 'continue') {
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
            topRemaining: execTop ? execTop.total - execTop.elapsed : null,
        };
    }
    enterFrame(p, tick) {
        const cfg = this.state.cfg.get(p.lineId);
        this.state.pending = this.state.pending.filter((x) => x !== p);
        this.state.stack.push({
            lineId: p.lineId,
            total: cfg.handlerTicks,
            elapsed: 0,
            enteredAt: tick,
            preempted: false,
        });
        this.state.runningIds.add(p.lineId);
    }
}
function eventLabel(kind) {
    switch (kind) {
        case 'raise':
            return 'raise（触发/拉高）';
        case 'lower':
            return 'lower（撤销电平）';
        case 'mask':
            return 'mask（屏蔽）';
        case 'unmask':
            return 'unmask（解除屏蔽）';
        default:
            return kind;
    }
}
/** 整批回放：推进到无剩余工作或达到 500 tick 上限。 */
export function runReplay(lines, events) {
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
