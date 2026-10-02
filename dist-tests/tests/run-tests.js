/**
 * 测试入口：
 *  1. 手写期望序列 —— 嵌套抢占、同优先级等待、屏蔽期边沿保留/合并、
 *     电平重入、电平屏蔽/解除、严格高优先级抢占、运行期边沿重入；
 *  2. 逐 tick 参考状态机交叉核对（参考机永远 step1，被测机用不同批次推进）；
 *  3. 随机配置/事件模糊测试；
 *  4. 500 tick 截断。
 */
import { ReplayController, runReplay, validateInput } from '../simulator.js';
import { ReferenceMachine } from './reference-machine.js';
let passed = 0;
let failed = 0;
function ok(cond, msg) {
    if (cond) {
        passed++;
    }
    else {
        failed++;
        console.error(`  ✗ ${msg}`);
    }
}
function eq(actual, expected, msg) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    ok(a === e, `${msg}\n      期望 ${e}\n      实际 ${a}`);
}
function describe(name, fn) {
    console.log(`• ${name}`);
    fn();
}
/** 动作序列简表，便于手写期望。 */
function actions(trace) {
    return trace.ticks.map((r) => {
        switch (r.action.type) {
            case 'enter':
                return `enter:${r.action.lineId}`;
            case 'preempt':
                return `preempt:${r.action.by}>${r.action.resumed}`;
            case 'resume':
                return `resume:${r.action.lineId}`;
            case 'continue':
                return `cont:${r.action.lineId}`;
            case 'idle':
                return 'idle';
        }
    });
}
function completes(trace) {
    return trace.ticks.filter((r) => r.completed).map((r) => [r.tick, r.completed.lineId]);
}
function stackIdsAt(trace, t) {
    return trace.ticks[t - 1].stack.map((f) => f.lineId);
}
// ---------------------------------------------------------------------------
// 场景 1：三层嵌套抢占 + 恢复顺序
// ---------------------------------------------------------------------------
describe('嵌套抢占：A(4t,p1) ← B(2t,p2) ← C(1t,p3)', () => {
    const lines = [
        { id: 'A', priority: 1, mode: 'edge', handlerTicks: 4 },
        { id: 'B', priority: 2, mode: 'edge', handlerTicks: 2 },
        { id: 'C', priority: 3, mode: 'edge', handlerTicks: 1 },
    ];
    const events = [
        { at: 1, lineId: 'A', kind: 'raise' },
        { at: 2, lineId: 'B', kind: 'raise' },
        { at: 3, lineId: 'C', kind: 'raise' },
    ];
    const trace = runReplay(lines, events);
    eq(actions(trace), [
        'enter:A',
        'preempt:B>A',
        'preempt:C>B',
        'resume:B',
        'resume:A',
        'cont:A',
        'cont:A',
        'idle',
    ], '动作序列');
    eq(completes(trace), [[4, 'C'], [5, 'B'], [8, 'A']], '完成时刻（被抢占 tick 不计耗时）');
    eq(stackIdsAt(trace, 3), ['A', 'B', 'C'], 'tick3 末执行栈为 A→B→C');
    eq(stackIdsAt(trace, 4), ['A', 'B'], 'tick4 C 完成并出栈');
    eq(trace.ticks[3].stack[1].elapsed, 2, 'tick4 B 累计 2 tick 后完成');
    eq(trace.ticks[4].stack[0].elapsed, 2, 'tick5 A 恢复时仅累计了被抢占前的 1 tick + 本 tick');
});
// ---------------------------------------------------------------------------
// 场景 2：同优先级按 待处理时刻 + ID 等待
// ---------------------------------------------------------------------------
describe('同优先级排队：同 tick 按 ID，跨 tick 按 since', () => {
    const lines = [
        { id: 'X', priority: 2, mode: 'edge', handlerTicks: 1 },
        { id: 'Y', priority: 2, mode: 'edge', handlerTicks: 1 },
        { id: 'Z', priority: 2, mode: 'edge', handlerTicks: 2 },
    ];
    const events = [
        { at: 1, lineId: 'Y', kind: 'raise' },
        { at: 1, lineId: 'X', kind: 'raise' },
        { at: 2, lineId: 'Z', kind: 'raise' },
    ];
    const trace = runReplay(lines, events);
    eq(actions(trace), ['enter:X', 'enter:Y', 'enter:Z', 'cont:Z', 'idle'], '同 tick 的 X 排在 Y 前（ID 序），Z 因 since=2 最后');
    // tick1 末，X 在执行，Y 与 Z 尚未出现；tick2 末：Y 执行、Z 等待
    eq(trace.ticks[1].pending.map((p) => p.lineId), ['Z'], 'tick2 末仅 Z 待处理（同优先级不抢占，等 Y 完成）');
});
// ---------------------------------------------------------------------------
// 场景 3：边沿屏蔽期保留待处理位，重复触发合并
// ---------------------------------------------------------------------------
describe('边沿：屏蔽期保留 1 个待处理位，重复触发合并', () => {
    const lines = [{ id: 'E', priority: 1, mode: 'edge', handlerTicks: 1 }];
    const events = [
        { at: 1, lineId: 'E', kind: 'mask' },
        { at: 2, lineId: 'E', kind: 'raise' },
        { at: 3, lineId: 'E', kind: 'raise' },
        { at: 3, lineId: 'E', kind: 'raise' },
        { at: 4, lineId: 'E', kind: 'unmask' },
    ];
    const trace = runReplay(lines, events);
    const pendAt3 = trace.ticks[2].pending.find((p) => p.lineId === 'E');
    eq(pendAt3, { lineId: 'E', since: 2, hits: 3, kind: 'edge' }, 'tick3 末：3 次触发合并为 1 位');
    eq(actions(trace), ['idle', 'idle', 'idle', 'enter:E', 'idle'], '解除屏蔽后下一次调度才进入');
    eq(trace.ticks[3].pending.length, 0, 'tick4 进入后待处理位被消费');
});
// ---------------------------------------------------------------------------
// 场景 4：电平保持有效 → 完成后重入；lower 后再 raise
// ---------------------------------------------------------------------------
describe('电平重入：持续有效反复进入；lower 停止重入', () => {
    const lines = [{ id: 'L', priority: 1, mode: 'level', handlerTicks: 2 }];
    const events = [
        { at: 1, lineId: 'L', kind: 'raise' },
        { at: 4, lineId: 'L', kind: 'lower' },
        { at: 5, lineId: 'L', kind: 'raise' },
        { at: 7, lineId: 'L', kind: 'lower' },
    ];
    const trace = runReplay(lines, events);
    eq(actions(trace), ['enter:L', 'cont:L', 'enter:L', 'cont:L', 'enter:L', 'cont:L', 'idle'], '完成即重入（t3、t5），t7 完成时电平已撤销');
    eq(completes(trace), [[3, 'L'], [5, 'L'], [7, 'L']], '三次调用全部完成');
});
// ---------------------------------------------------------------------------
// 场景 4b：电平屏蔽期间完成不重入，解除屏蔽后凭仍有效电平再入
// ---------------------------------------------------------------------------
describe('电平：屏蔽挂起调度，解除屏蔽恢复（输入电平不丢失）', () => {
    const lines = [{ id: 'M', priority: 1, mode: 'level', handlerTicks: 2 }];
    const events = [
        { at: 1, lineId: 'M', kind: 'raise' },
        { at: 3, lineId: 'M', kind: 'mask' },
        { at: 5, lineId: 'M', kind: 'unmask' },
        { at: 6, lineId: 'M', kind: 'lower' },
    ];
    const trace = runReplay(lines, events);
    eq(actions(trace), ['enter:M', 'cont:M', 'idle', 'idle', 'enter:M', 'cont:M', 'idle'], 't3 完成时被屏蔽 → 不重入；t5 解除屏蔽重新进入');
    eq(trace.ticks[2].masked, ['M'], 'tick3 末 M 处于屏蔽');
    eq(trace.ticks[2].levelAsserted, ['M'], '屏蔽不撤销输入电平（证据保留）');
});
// ---------------------------------------------------------------------------
// 场景 5：仅严格更高优先级可抢占
// ---------------------------------------------------------------------------
describe('抢占门槛：低优先级等待，高优先级抢占，恢复后低优先级才进入', () => {
    const lines = [
        { id: 'P', priority: 2, mode: 'edge', handlerTicks: 3 },
        { id: 'Q', priority: 1, mode: 'edge', handlerTicks: 1 },
        { id: 'R', priority: 3, mode: 'edge', handlerTicks: 1 },
    ];
    const events = [
        { at: 1, lineId: 'P', kind: 'raise' },
        { at: 2, lineId: 'Q', kind: 'raise' },
        { at: 3, lineId: 'R', kind: 'raise' },
    ];
    const trace = runReplay(lines, events);
    eq(actions(trace), ['enter:P', 'cont:P', 'preempt:R>P', 'resume:P', 'enter:Q', 'idle'], 'Q 低优先级在 P 运行期间等待；R 抢占；P 完成后 Q 才进入');
});
// ---------------------------------------------------------------------------
// 场景 6：处理程序运行期间再次触发边沿 → 完成后重入
// ---------------------------------------------------------------------------
describe('边沿：运行期触发挂起，完成后重入一次', () => {
    const lines = [{ id: 'S', priority: 1, mode: 'edge', handlerTicks: 3 }];
    const events = [
        { at: 1, lineId: 'S', kind: 'raise' },
        { at: 2, lineId: 'S', kind: 'raise' },
    ];
    const trace = runReplay(lines, events);
    eq(actions(trace), ['enter:S', 'cont:S', 'cont:S', 'enter:S', 'cont:S', 'cont:S', 'idle'], '运行期边沿只挂 1 位，t4 完成后再入，不会无限重入');
});
// ---------------------------------------------------------------------------
// 场景 7：屏蔽运行中的线不杀处理程序；解除屏蔽不合成边沿
// ---------------------------------------------------------------------------
describe('屏蔽正在运行的线：当前处理程序跑完；屏蔽期边沿解除后生效', () => {
    const lines = [{ id: 'K', priority: 1, mode: 'edge', handlerTicks: 2 }];
    const events = [
        { at: 1, lineId: 'K', kind: 'raise' },
        { at: 2, lineId: 'K', kind: 'mask' },
        { at: 3, lineId: 'K', kind: 'unmask' },
    ];
    const trace = runReplay(lines, events);
    eq(actions(trace), ['enter:K', 'cont:K', 'idle'], '屏蔽不打断 K；解除屏蔽不会补出边沿');
});
// ---------------------------------------------------------------------------
// 场景 8：setMode 边沿→电平 —— 旧模式遗留的待处理位失效，不凭旧位进入
// ---------------------------------------------------------------------------
describe('模式切换：边沿屏蔽期合并的待处理位在切成电平时丢弃', () => {
    const lines = [{ id: 'E', priority: 1, mode: 'edge', handlerTicks: 1 }];
    const events = [
        { at: 1, lineId: 'E', kind: 'mask' },
        { at: 2, lineId: 'E', kind: 'raise' },
        { at: 3, lineId: 'E', kind: 'raise' },
        { at: 3, lineId: 'E', kind: 'raise' },
        { at: 4, lineId: 'E', kind: 'setMode', mode: 'level' },
        { at: 4, lineId: 'E', kind: 'unmask' },
        { at: 6, lineId: 'E', kind: 'raise' },
        { at: 8, lineId: 'E', kind: 'lower' },
    ];
    const trace = runReplay(lines, events);
    eq(trace.ticks[2].pending, [{ lineId: 'E', since: 2, hits: 3, kind: 'edge' }], 'tick3 末：屏蔽期 3 次触发合并为 1 个边沿位');
    eq(trace.ticks[3].pending, [], 'tick4 切成电平模式：旧边沿待处理位被丢弃');
    eq(trace.ticks[3].levelAsserted, [], 'tick4 末：无已记电平（解除屏蔽不合成输入）');
    eq(actions(trace), ['idle', 'idle', 'idle', 'idle', 'idle', 'enter:E', 'enter:E', 'idle'], '旧待处理位不被执行；t6 拉高电平后才按电平语义进入并重入');
    eq(completes(trace), [[7, 'E'], [8, 'E']], '电平保持有效时完成即重入，lower 后停止');
});
// ---------------------------------------------------------------------------
// 场景 9：setMode 电平→边沿（运行中）—— 处理程序跑完，已记电平失效，不重入
// ---------------------------------------------------------------------------
describe('模式切换：运行中的电平线切成边沿，处理程序继续完成且不重入', () => {
    const lines = [{ id: 'L', priority: 1, mode: 'level', handlerTicks: 2 }];
    const events = [
        { at: 1, lineId: 'L', kind: 'raise' },
        { at: 2, lineId: 'L', kind: 'setMode', mode: 'edge' },
    ];
    const trace = runReplay(lines, events);
    eq(actions(trace), ['enter:L', 'cont:L', 'idle'], '切换模式不杀运行中的处理程序');
    eq(completes(trace), [[3, 'L']], 't3 正常完成');
    eq(trace.ticks[1].levelAsserted, [], '切成边沿时已记电平失效（不合成边沿、不留证据）');
    eq(trace.ticks[2].pending, [], '完成后不重入（当前为边沿模式且无新触发）');
});
// ---------------------------------------------------------------------------
// 场景 10：setPriority 调低运行中的线 —— 严格更高的等待线当 tick 抢占
// ---------------------------------------------------------------------------
describe('调级：运行中线被调低后，等待中的高优先级线当 tick 抢占', () => {
    const lines = [
        { id: 'A', priority: 3, mode: 'edge', handlerTicks: 4 },
        { id: 'B', priority: 2, mode: 'edge', handlerTicks: 1 },
    ];
    const events = [
        { at: 1, lineId: 'A', kind: 'raise' },
        { at: 2, lineId: 'B', kind: 'raise' },
        { at: 3, lineId: 'A', kind: 'setPriority', priority: 1 },
    ];
    const trace = runReplay(lines, events);
    eq(actions(trace), ['enter:A', 'cont:A', 'preempt:B>A', 'resume:A', 'cont:A', 'idle'], 't3 调低 A 至 1 后，B(2) 当 tick 即可抢占；A 之后恢复并跑完');
    eq(completes(trace), [[4, 'B'], [6, 'A']], 'B 先完成，A 恢复后完成（被抢占比特不计耗时）');
    const preemptLogs = trace.logs.filter((l) => l.type === 'preempt');
    eq(preemptLogs.length, 1, '日志中恰有一次抢占记录');
    ok(preemptLogs[0]?.tick === 3 && preemptLogs[0]?.detail.includes('优先级 2') && preemptLogs[0]?.detail.includes('优先级 1'), '抢占日志与调度决策使用同一组（当前）优先级，不再互相矛盾');
});
// ---------------------------------------------------------------------------
// 场景 10b：setPriority 调到与等待线相同 —— 同优先级仍不抢占
// ---------------------------------------------------------------------------
describe('调级：调到相同优先级仍不抢占（严格更高门槛）', () => {
    const lines = [
        { id: 'A', priority: 3, mode: 'edge', handlerTicks: 3 },
        { id: 'B', priority: 2, mode: 'edge', handlerTicks: 1 },
    ];
    const events = [
        { at: 1, lineId: 'A', kind: 'raise' },
        { at: 2, lineId: 'B', kind: 'raise' },
        { at: 3, lineId: 'A', kind: 'setPriority', priority: 2 },
    ];
    const trace = runReplay(lines, events);
    eq(actions(trace), ['enter:A', 'cont:A', 'cont:A', 'enter:B', 'idle'], 'A 调到与 B 相同的 2：同优先级不抢占，A 跑完后 B 才进入');
});
// ---------------------------------------------------------------------------
// 交叉核对：不同批次推进 vs 参考状态机（逐 tick）
// ---------------------------------------------------------------------------
function normalize(rec) {
    return JSON.stringify({
        tick: rec.tick,
        eventsApplied: rec.eventsApplied,
        completed: rec.completed ?? null,
        action: rec.action,
        stack: rec.stack.map((f) => ({
            lineId: f.lineId,
            total: f.total,
            elapsed: f.elapsed,
            preempted: f.preempted,
            enteredAt: f.enteredAt,
        })),
        pending: rec.pending,
        levelAsserted: rec.levelAsserted,
        masked: rec.masked,
        topRemaining: rec.topRemaining,
    });
}
function crossCheck(name, lines, events) {
    // 参考机：永远一步一拍。
    const ref = new ReferenceMachine(lines, events);
    const refRecs = [];
    let r = ref.step1();
    while (r) {
        refRecs.push(normalize(r));
        r = ref.step1();
    }
    const batches = [1, 2, 3, 5, 11, 'all'];
    for (const b of batches) {
        const ctrl = new ReplayController(lines, events);
        if (b === 'all') {
            while (ctrl.step() !== null) {
                /* run to quiescence */
            }
        }
        else {
            while (ctrl.advance(b).length > 0) {
                /* 按批次推进到静止 */
            }
        }
        const got = ctrl.ticks.map(normalize);
        eq(got.length === refRecs.length && got.every((s, i) => s === refRecs[i]), true, `[${name}] 批次=${b} 与逐 tick 参考机逐状态一致（${got.length} ticks）`);
    }
}
describe('不同批次推进 ↔ 逐 tick 参考状态机（固定场景）', () => {
    crossCheck('嵌套抢占', [
        { id: 'A', priority: 1, mode: 'edge', handlerTicks: 4 },
        { id: 'B', priority: 2, mode: 'edge', handlerTicks: 2 },
        { id: 'C', priority: 3, mode: 'edge', handlerTicks: 1 },
    ], [
        { at: 1, lineId: 'A', kind: 'raise' },
        { at: 2, lineId: 'B', kind: 'raise' },
        { at: 3, lineId: 'C', kind: 'raise' },
    ]);
    crossCheck('电平+屏蔽', [{ id: 'M', priority: 1, mode: 'level', handlerTicks: 2 }], [
        { at: 1, lineId: 'M', kind: 'raise' },
        { at: 3, lineId: 'M', kind: 'mask' },
        { at: 5, lineId: 'M', kind: 'unmask' },
        { at: 6, lineId: 'M', kind: 'lower' },
    ]);
    crossCheck('同优先级混合', [
        { id: 'X', priority: 2, mode: 'edge', handlerTicks: 2 },
        { id: 'Y', priority: 2, mode: 'level', handlerTicks: 1 },
        { id: 'Z', priority: 3, mode: 'edge', handlerTicks: 1, initiallyMasked: true },
    ], [
        { at: 1, lineId: 'X', kind: 'raise' },
        { at: 1, lineId: 'Y', kind: 'raise' },
        { at: 2, lineId: 'Z', kind: 'raise' },
        { at: 3, lineId: 'Z', kind: 'unmask' },
        { at: 4, lineId: 'Y', kind: 'lower' },
        { at: 5, lineId: 'Y', kind: 'raise' },
    ]);
    crossCheck('模式切换 + 调级抢占', [
        { id: 'E', priority: 1, mode: 'edge', handlerTicks: 1 },
        { id: 'A', priority: 3, mode: 'edge', handlerTicks: 4 },
        { id: 'B', priority: 2, mode: 'edge', handlerTicks: 1 },
    ], [
        { at: 1, lineId: 'E', kind: 'mask' },
        { at: 1, lineId: 'A', kind: 'raise' },
        { at: 2, lineId: 'E', kind: 'raise' },
        { at: 2, lineId: 'B', kind: 'raise' },
        { at: 3, lineId: 'A', kind: 'setPriority', priority: 1 },
        { at: 4, lineId: 'E', kind: 'setMode', mode: 'level' },
        { at: 4, lineId: 'E', kind: 'unmask' },
    ]);
    crossCheck('运行中切模式（电平→边沿）', [
        { id: 'L', priority: 2, mode: 'level', handlerTicks: 3 },
        { id: 'K', priority: 1, mode: 'edge', handlerTicks: 1 },
    ], [
        { at: 1, lineId: 'L', kind: 'raise' },
        { at: 2, lineId: 'L', kind: 'setMode', mode: 'edge' },
        { at: 3, lineId: 'K', kind: 'raise' },
        { at: 5, lineId: 'L', kind: 'raise' },
        { at: 6, lineId: 'L', kind: 'setMode', mode: 'level' },
        { at: 7, lineId: 'L', kind: 'raise' },
    ]);
});
// ---------------------------------------------------------------------------
// 模糊测试：确定性 PRNG，参考机核对 200 个随机场景
// ---------------------------------------------------------------------------
function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
describe('模糊测试：200 个随机场景，逐状态对齐参考机', () => {
    const rand = mulberry32(20261001);
    const kinds = ['raise', 'lower', 'mask', 'unmask', 'setPriority', 'setMode'];
    let mismatch = 0;
    for (let it = 0; it < 200; it++) {
        const n = 1 + Math.floor(rand() * 8);
        const ids = Array.from({ length: n }, (_, i) => 'L' + i);
        const lines = ids.map((id) => ({
            id,
            priority: 1 + Math.floor(rand() * 4),
            mode: rand() < 0.5 ? 'edge' : 'level',
            handlerTicks: 1 + Math.floor(rand() * 4),
            initiallyMasked: rand() < 0.15,
        }));
        const evCount = Math.floor(rand() * 24);
        const events = Array.from({ length: evCount }, () => {
            const kind = kinds[Math.floor(rand() * kinds.length)];
            const ev = {
                at: 1 + Math.floor(rand() * 30),
                lineId: ids[Math.floor(rand() * n)],
                kind,
            };
            if (kind === 'setPriority')
                ev.priority = 1 + Math.floor(rand() * 4);
            if (kind === 'setMode')
                ev.mode = rand() < 0.5 ? 'edge' : 'level';
            return ev;
        });
        const ref = new ReferenceMachine(lines, events);
        const refRecs = [];
        let rr = ref.step1();
        while (rr) {
            refRecs.push(normalize(rr));
            rr = ref.step1();
        }
        const batch = [1, 2, 7][it % 3];
        const ctrl = new ReplayController(lines, events);
        while (ctrl.advance(batch).length > 0) {
            /* drain */
        }
        const got = ctrl.ticks.map(normalize);
        if (got.length !== refRecs.length || got.some((s, i) => s !== refRecs[i])) {
            mismatch++;
            console.error(`  ✗ 随机场景 #${it} 不一致（n=${n}, events=${evCount}, batch=${batch}）`);
        }
    }
    eq(mismatch, 0, `200 个随机场景全部与参考机一致（不一致 ${mismatch} 个）`);
});
// ---------------------------------------------------------------------------
// 500 tick 上限：持续有效的电平线无限重入 → 截断标记
// ---------------------------------------------------------------------------
describe('回放窗口：至多 500 tick，超出截断并标记', () => {
    const trace = runReplay([{ id: 'H', priority: 1, mode: 'level', handlerTicks: 2 }], [{ at: 1, lineId: 'H', kind: 'raise' }]);
    eq(trace.ticks.length, 500, '持续电平重入恰好在 500 tick 处停止');
    eq(trace.truncated, true, 'truncated = true 作为截断证据');
    eq(trace.ticks[499].tick, 500, '最后一个记录为 tick 500');
});
// ---------------------------------------------------------------------------
// 输入校验
// ---------------------------------------------------------------------------
describe('配置校验：1～8 线、唯一 ID、handlerTicks >= 1、越界事件告警', () => {
    ok(validateInput([], []).errors.length === 1, '0 条线被拒绝');
    ok(validateInput(Array.from({ length: 9 }, (_, i) => ({ id: 'X' + i, priority: 1, mode: 'edge', handlerTicks: 1 })), []).errors.length === 1, '9 条线被拒绝');
    ok(validateInput([
        { id: 'D', priority: 1, mode: 'edge', handlerTicks: 1 },
        { id: 'D', priority: 1, mode: 'edge', handlerTicks: 1 },
    ], []).errors.length >= 1, '重复 ID 被拒绝');
    ok(validateInput([{ id: 'E', priority: 1, mode: 'edge', handlerTicks: 0 }], []).errors.length >= 1, 'handlerTicks=0 被拒绝');
    ok(validateInput([{ id: 'E', priority: 1, mode: 'edge', handlerTicks: 1 }], [
        { at: 501, lineId: 'E', kind: 'raise' },
    ]).warnings.length === 1, 'tick>500 的事件产生告警');
});
// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0)
    process.exit(1);
