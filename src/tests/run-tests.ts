/**
 * 测试入口：
 *  1. 手写期望序列 —— 嵌套抢占、同优先级等待、屏蔽期边沿保留/合并、
 *     电平重入、电平屏蔽/解除、严格高优先级抢占、运行期边沿重入；
 *  2. 逐 tick 参考状态机交叉核对（参考机永远 step1，被测机用不同批次推进）；
 *  3. 随机配置/事件模糊测试；
 *  4. 500 tick 截断。
 */

import { LineConfig, ScheduledEvent, TickRecord, Trace } from '../model.js';
import { ReplayController, runReplay, validateInput } from '../simulator.js';
import { ReferenceMachine } from './reference-machine.js';

let passed = 0;
let failed = 0;

function ok(cond: boolean, msg: string): void {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

function eq<T>(actual: T, expected: T, msg: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  ok(a === e, `${msg}\n      期望 ${e}\n      实际 ${a}`);
}

function describe(name: string, fn: () => void): void {
  console.log(`• ${name}`);
  fn();
}

/** 动作序列简表，便于手写期望。 */
function actions(trace: Trace): Array<string> {
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

function completes(trace: Trace): Array<[number, string]> {
  return trace.ticks.filter((r) => r.completed).map((r) => [r.tick, r.completed!.lineId]);
}

function stackIdsAt(trace: Trace, t: number): string[] {
  return trace.ticks[t - 1].stack.map((f) => f.lineId);
}

// ---------------------------------------------------------------------------
// 场景 1：三层嵌套抢占 + 恢复顺序
// ---------------------------------------------------------------------------
describe('嵌套抢占：A(4t,p1) ← B(2t,p2) ← C(1t,p3)', () => {
  const lines: LineConfig[] = [
    { id: 'A', priority: 1, mode: 'edge', handlerTicks: 4 },
    { id: 'B', priority: 2, mode: 'edge', handlerTicks: 2 },
    { id: 'C', priority: 3, mode: 'edge', handlerTicks: 1 },
  ];
  const events: ScheduledEvent[] = [
    { at: 1, lineId: 'A', kind: 'raise' },
    { at: 2, lineId: 'B', kind: 'raise' },
    { at: 3, lineId: 'C', kind: 'raise' },
  ];
  const trace = runReplay(lines, events);

  eq(
    actions(trace),
    [
      'enter:A',
      'preempt:B>A',
      'preempt:C>B',
      'resume:B',
      'resume:A',
      'cont:A',
      'cont:A',
      'idle',
    ],
    '动作序列'
  );
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
  const lines: LineConfig[] = [
    { id: 'X', priority: 2, mode: 'edge', handlerTicks: 1 },
    { id: 'Y', priority: 2, mode: 'edge', handlerTicks: 1 },
    { id: 'Z', priority: 2, mode: 'edge', handlerTicks: 2 },
  ];
  const events: ScheduledEvent[] = [
    { at: 1, lineId: 'Y', kind: 'raise' },
    { at: 1, lineId: 'X', kind: 'raise' },
    { at: 2, lineId: 'Z', kind: 'raise' },
  ];
  const trace = runReplay(lines, events);
  eq(
    actions(trace),
    ['enter:X', 'enter:Y', 'enter:Z', 'cont:Z', 'idle'],
    '同 tick 的 X 排在 Y 前（ID 序），Z 因 since=2 最后'
  );
  // tick1 末，X 在执行，Y 与 Z 尚未出现；tick2 末：Y 执行、Z 等待
  eq(
    trace.ticks[1].pending.map((p) => p.lineId),
    ['Z'],
    'tick2 末仅 Z 待处理（同优先级不抢占，等 Y 完成）'
  );
});

// ---------------------------------------------------------------------------
// 场景 3：边沿屏蔽期保留待处理位，重复触发合并
// ---------------------------------------------------------------------------
describe('边沿：屏蔽期保留 1 个待处理位，重复触发合并', () => {
  const lines: LineConfig[] = [{ id: 'E', priority: 1, mode: 'edge', handlerTicks: 1 }];
  const events: ScheduledEvent[] = [
    { at: 1, lineId: 'E', kind: 'mask' },
    { at: 2, lineId: 'E', kind: 'raise' },
    { at: 3, lineId: 'E', kind: 'raise' },
    { at: 3, lineId: 'E', kind: 'raise' },
    { at: 4, lineId: 'E', kind: 'unmask' },
  ];
  const trace = runReplay(lines, events);
  const pendAt3 = trace.ticks[2].pending.find((p) => p.lineId === 'E')!;
  eq(pendAt3, { lineId: 'E', since: 2, hits: 3, origin: 'edge' }, 'tick3 末：3 次触发合并为 1 位');
  eq(actions(trace), ['idle', 'idle', 'idle', 'enter:E', 'idle'], '解除屏蔽后下一次调度才进入');
  eq(trace.ticks[3].pending.length, 0, 'tick4 进入后待处理位被消费');
});

// ---------------------------------------------------------------------------
// 场景 4：电平保持有效 → 完成后重入；lower 后再 raise
// ---------------------------------------------------------------------------
describe('电平重入：持续有效反复进入；lower 停止重入', () => {
  const lines: LineConfig[] = [{ id: 'L', priority: 1, mode: 'level', handlerTicks: 2 }];
  const events: ScheduledEvent[] = [
    { at: 1, lineId: 'L', kind: 'raise' },
    { at: 4, lineId: 'L', kind: 'lower' },
    { at: 5, lineId: 'L', kind: 'raise' },
    { at: 7, lineId: 'L', kind: 'lower' },
  ];
  const trace = runReplay(lines, events);
  eq(
    actions(trace),
    ['enter:L', 'cont:L', 'enter:L', 'cont:L', 'enter:L', 'cont:L', 'idle'],
    '完成即重入（t3、t5），t7 完成时电平已撤销'
  );
  eq(completes(trace), [[3, 'L'], [5, 'L'], [7, 'L']], '三次调用全部完成');
});

// ---------------------------------------------------------------------------
// 场景 4b：电平屏蔽期间完成不重入，解除屏蔽后凭仍有效电平再入
// ---------------------------------------------------------------------------
describe('电平：屏蔽挂起调度，解除屏蔽恢复（输入电平不丢失）', () => {
  const lines: LineConfig[] = [{ id: 'M', priority: 1, mode: 'level', handlerTicks: 2 }];
  const events: ScheduledEvent[] = [
    { at: 1, lineId: 'M', kind: 'raise' },
    { at: 3, lineId: 'M', kind: 'mask' },
    { at: 5, lineId: 'M', kind: 'unmask' },
    { at: 6, lineId: 'M', kind: 'lower' },
  ];
  const trace = runReplay(lines, events);
  eq(
    actions(trace),
    ['enter:M', 'cont:M', 'idle', 'idle', 'enter:M', 'cont:M', 'idle'],
    't3 完成时被屏蔽 → 不重入；t5 解除屏蔽重新进入'
  );
  eq(trace.ticks[2].masked, ['M'], 'tick3 末 M 处于屏蔽');
  eq(trace.ticks[2].levelAsserted, ['M'], '屏蔽不撤销输入电平（证据保留）');
});

// ---------------------------------------------------------------------------
// 场景 5：仅严格更高优先级可抢占
// ---------------------------------------------------------------------------
describe('抢占门槛：低优先级等待，高优先级抢占，恢复后低优先级才进入', () => {
  const lines: LineConfig[] = [
    { id: 'P', priority: 2, mode: 'edge', handlerTicks: 3 },
    { id: 'Q', priority: 1, mode: 'edge', handlerTicks: 1 },
    { id: 'R', priority: 3, mode: 'edge', handlerTicks: 1 },
  ];
  const events: ScheduledEvent[] = [
    { at: 1, lineId: 'P', kind: 'raise' },
    { at: 2, lineId: 'Q', kind: 'raise' },
    { at: 3, lineId: 'R', kind: 'raise' },
  ];
  const trace = runReplay(lines, events);
  eq(
    actions(trace),
    ['enter:P', 'cont:P', 'preempt:R>P', 'resume:P', 'enter:Q', 'idle'],
    'Q 低优先级在 P 运行期间等待；R 抢占；P 完成后 Q 才进入'
  );
});

// ---------------------------------------------------------------------------
// 场景 6：处理程序运行期间再次触发边沿 → 完成后重入
// ---------------------------------------------------------------------------
describe('边沿：运行期触发挂起，完成后重入一次', () => {
  const lines: LineConfig[] = [{ id: 'S', priority: 1, mode: 'edge', handlerTicks: 3 }];
  const events: ScheduledEvent[] = [
    { at: 1, lineId: 'S', kind: 'raise' },
    { at: 2, lineId: 'S', kind: 'raise' },
  ];
  const trace = runReplay(lines, events);
  eq(
    actions(trace),
    ['enter:S', 'cont:S', 'cont:S', 'enter:S', 'cont:S', 'cont:S', 'idle'],
    '运行期边沿只挂 1 位，t4 完成后再入，不会无限重入'
  );
});

// ---------------------------------------------------------------------------
// 场景 7：屏蔽运行中的线不杀处理程序；解除屏蔽不合成边沿
// ---------------------------------------------------------------------------
describe('屏蔽正在运行的线：当前处理程序跑完；屏蔽期边沿解除后生效', () => {
  const lines: LineConfig[] = [{ id: 'K', priority: 1, mode: 'edge', handlerTicks: 2 }];
  const events: ScheduledEvent[] = [
    { at: 1, lineId: 'K', kind: 'raise' },
    { at: 2, lineId: 'K', kind: 'mask' },
    { at: 3, lineId: 'K', kind: 'unmask' },
  ];
  const trace = runReplay(lines, events);
  eq(actions(trace), ['enter:K', 'cont:K', 'idle'], '屏蔽不打断 K；解除屏蔽不会补出边沿');
});

// ---------------------------------------------------------------------------
// 场景 8：模式切换 + 同 tick 调级（控制器工程师的中断回放情形）
//  - A 先屏蔽并以边沿触发（旧待处理位），t3 改电平并解除屏蔽：旧边沿位仍执行一次；
//  - B 正在运行，t3 同 tick 被调低优先级（p3→p1），C(p2) 等待：
//    调级当 tick C 不能抢占，且之后也不能借调级抢占（门槛冻结在进入时 p3）；
//  - 运行中的 B 一直跑完；不同批次推进轨迹一致由后续 crossCheck 保证。
// ---------------------------------------------------------------------------
describe('模式切换 + 同 tick 调级：旧边沿位仍执行；调级当 tick 不抢占；运行者跑完', () => {
  const lines: LineConfig[] = [
    { id: 'A', priority: 2, mode: 'edge', handlerTicks: 2 },
    { id: 'B', priority: 3, mode: 'edge', handlerTicks: 4 },
    { id: 'C', priority: 2, mode: 'edge', handlerTicks: 1 },
  ];
  const events: ScheduledEvent[] = [
    { at: 1, lineId: 'A', kind: 'mask' },
    { at: 1, lineId: 'A', kind: 'raise' },
    { at: 2, lineId: 'B', kind: 'raise' },
    { at: 2, lineId: 'C', kind: 'raise' },
    { at: 3, lineId: 'A', kind: 'setMode', mode: 'level' },
    { at: 3, lineId: 'A', kind: 'unmask' },
    { at: 3, lineId: 'B', kind: 'setPriority', priority: 1 },
  ];
  const trace = runReplay(lines, events);
  eq(
    actions(trace),
    ['idle', 'enter:B', 'cont:B', 'cont:B', 'cont:B', 'enter:A', 'cont:A', 'enter:C', 'idle'],
    'C 在 t3 调级当 tick 不抢占 B；B 跑完（t5 收尾，t6 出栈）'
  );
  eq(completes(trace), [[6, 'B'], [8, 'A'], [9, 'C']], 'B 跑完后 A（旧边沿位）再到 C');

  // t3 末：A 已切成电平并解除屏蔽，但待处理位仍是切模式前的旧 edge 位。
  const pendA3 = trace.ticks[2].pending.find((p) => p.lineId === 'A')!;
  eq(pendA3.origin, 'edge', '旧边沿位切到电平后来源仍为 edge（三视图一致：仍执行一次）');
  const modeA3 = trace.ticks[2].lineStates.find((l) => l.lineId === 'A')!;
  eq(modeA3, { lineId: 'A', priority: 2, mode: 'level' }, 't3 末 A 当前模式确为 level');
  const priB3 = trace.ticks[2].lineStates.find((l) => l.lineId === 'B')!;
  eq(priB3.priority, 1, 't3 末 B 当前优先级已降为 1');
  eq(trace.ticks[2].stack[0].entryPriority, 3, '栈中 B 帧的抢占门槛仍冻结在进入时 p3');

  // 旧 edge 位只执行一次：A 在电平模式下没有物理电平，t6 进入后不会重入。
  eq(trace.ticks[5].levelAsserted.includes('A'), false, '切模式本身不合成物理电平');
  const aRuns = trace.ticks.filter((r) => r.stack.some((f) => f.lineId === 'A')).length;
  eq(aRuns, 2, 'A 的旧待处理位仅执行一次（2 个执行 tick），不重入');
});

// ---------------------------------------------------------------------------
// 场景 9：edge→level 后旧边沿位对 lower 免疫，且只执行一次
// ---------------------------------------------------------------------------
describe('edge→level：遗留 edge 位不受 lower 影响，执行一次即消费', () => {
  const lines: LineConfig[] = [{ id: 'A', priority: 1, mode: 'edge', handlerTicks: 1 }];
  const events: ScheduledEvent[] = [
    { at: 1, lineId: 'A', kind: 'mask' },
    { at: 2, lineId: 'A', kind: 'raise' },
    { at: 3, lineId: 'A', kind: 'setMode', mode: 'level' },
    { at: 3, lineId: 'A', kind: 'lower' }, // 当前电平模式，但无物理电平且位是 edge 来源
    { at: 4, lineId: 'A', kind: 'unmask' },
  ];
  const trace = runReplay(lines, events);
  eq(actions(trace), ['idle', 'idle', 'idle', 'enter:A', 'idle'], 'lower 清不掉旧 edge 位，解除屏蔽后仍执行');
  const p3 = trace.ticks[2].pending.find((x) => x.lineId === 'A')!;
  eq(p3.origin, 'edge', 't3 末来源仍标记为 edge（与逐 tick 表/时间轴同源）');
});

// ---------------------------------------------------------------------------
// 场景 10：level→edge 后不重放残留物理电平（不无限重入）
// ---------------------------------------------------------------------------
describe('level→edge：处理完成不重入；残留物理电平不合成边沿', () => {
  const lines: LineConfig[] = [{ id: 'L', priority: 1, mode: 'level', handlerTicks: 2 }];
  const events: ScheduledEvent[] = [
    { at: 1, lineId: 'L', kind: 'raise' },
    { at: 2, lineId: 'L', kind: 'setMode', mode: 'edge' },
  ];
  const trace = runReplay(lines, events);
  eq(actions(trace), ['enter:L', 'cont:L', 'idle'], 't2 切成边沿后，t3 完成不再电平重入');
  eq(trace.ticks[2].levelAsserted, ['L'], '物理电平证据仍保留（仅不再驱动调度）');
});

// ---------------------------------------------------------------------------
// 场景 11：同一 tick 多个事件按输入顺序生效（含调级/切模式穿插）
// ---------------------------------------------------------------------------
describe('同 tick 多事件按输入顺序：先调级后触发，当 tick 即按新优先级调度', () => {
  const lines: LineConfig[] = [
    { id: 'P', priority: 3, mode: 'edge', handlerTicks: 3 },
    { id: 'Q', priority: 1, mode: 'edge', handlerTicks: 1 },
  ];
  const events: ScheduledEvent[] = [
    { at: 1, lineId: 'P', kind: 'raise' },
    // t2：先把 Q 调到比 P 进入门槛(p3)更高，再触发 Q —— 当 tick 即可抢占。
    { at: 2, lineId: 'Q', kind: 'setPriority', priority: 5 },
    { at: 2, lineId: 'Q', kind: 'raise' },
  ];
  const trace = runReplay(lines, events);
  eq(actions(trace), ['enter:P', 'preempt:Q>P', 'resume:P', 'cont:P', 'idle'],
    '同 tick 内 setPriority 先于 raise 生效，Q 以 p5 在当 tick 抢占；Q 完成后 P 跑完');
  eq(completes(trace), [[3, 'Q'], [5, 'P']], 'Q 先完成，P 恢复后跑完');
});

// ---------------------------------------------------------------------------
// 交叉核对：不同批次推进 vs 参考状态机（逐 tick）
// ---------------------------------------------------------------------------
function normalize(rec: TickRecord): string {
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
      entryPriority: f.entryPriority,
      entryMode: f.entryMode,
    })),
    pending: rec.pending,
    levelAsserted: rec.levelAsserted,
    masked: rec.masked,
    lineStates: rec.lineStates,
    topRemaining: rec.topRemaining,
  });
}

function crossCheck(name: string, lines: LineConfig[], events: ScheduledEvent[]): void {
  // 参考机：永远一步一拍。
  const ref = new ReferenceMachine(lines, events);
  const refRecs: string[] = [];
  let r = ref.step1();
  while (r) {
    refRecs.push(normalize(r as unknown as TickRecord));
    r = ref.step1();
  }

  const batches: Array<number | 'all'> = [1, 2, 3, 5, 11, 'all'];
  for (const b of batches) {
    const ctrl = new ReplayController(lines, events);
    if (b === 'all') {
      while (ctrl.step() !== null) {
        /* run to quiescence */
      }
    } else {
      while (ctrl.advance(b).length > 0) {
        /* 按批次推进到静止 */
      }
    }
    const got = ctrl.ticks.map(normalize);
    eq(
      got.length === refRecs.length && got.every((s, i) => s === refRecs[i]),
      true,
      `[${name}] 批次=${b} 与逐 tick 参考机逐状态一致（${got.length} ticks）`
    );
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

  // 场景 8 的输入也必须在各批次与逐 tick 参考机完全一致。
  crossCheck('模式切换+同tick调级', [
    { id: 'A', priority: 2, mode: 'edge', handlerTicks: 2 },
    { id: 'B', priority: 3, mode: 'edge', handlerTicks: 4 },
    { id: 'C', priority: 2, mode: 'edge', handlerTicks: 1 },
  ], [
    { at: 1, lineId: 'A', kind: 'mask' },
    { at: 1, lineId: 'A', kind: 'raise' },
    { at: 2, lineId: 'B', kind: 'raise' },
    { at: 2, lineId: 'C', kind: 'raise' },
    { at: 3, lineId: 'A', kind: 'setMode', mode: 'level' },
    { at: 3, lineId: 'A', kind: 'unmask' },
    { at: 3, lineId: 'B', kind: 'setPriority', priority: 1 },
  ]);

  // 两个方向的模式切换 + 电平撤销穿插。
  crossCheck('双向切模式+电平撤销', [
    { id: 'X', priority: 2, mode: 'edge', handlerTicks: 2 },
    { id: 'Y', priority: 1, mode: 'level', handlerTicks: 1 },
  ], [
    { at: 1, lineId: 'X', kind: 'mask' },
    { at: 1, lineId: 'X', kind: 'raise' },
    { at: 2, lineId: 'X', kind: 'setMode', mode: 'level' },
    { at: 2, lineId: 'X', kind: 'lower' },
    { at: 3, lineId: 'X', kind: 'unmask' },
    { at: 1, lineId: 'Y', kind: 'raise' },
    { at: 2, lineId: 'Y', kind: 'setMode', mode: 'edge' },
    { at: 4, lineId: 'Y', kind: 'raise' },
    { at: 5, lineId: 'Y', kind: 'setMode', mode: 'level' },
    { at: 5, lineId: 'Y', kind: 'raise' },
  ]);
});

// ---------------------------------------------------------------------------
// 模糊测试：确定性 PRNG，参考机核对 200 个随机场景
// ---------------------------------------------------------------------------
function mulberry32(seed: number): () => number {
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
  const kinds: ScheduledEvent['kind'][] = ['raise', 'lower', 'mask', 'unmask', 'setPriority', 'setMode'];
  let mismatch = 0;
  for (let it = 0; it < 200; it++) {
    const n = 1 + Math.floor(rand() * 8);
    const ids = Array.from({ length: n }, (_, i) => 'L' + i);
    const lines: LineConfig[] = ids.map((id) => ({
      id,
      priority: 1 + Math.floor(rand() * 4),
      mode: rand() < 0.5 ? 'edge' : 'level',
      handlerTicks: 1 + Math.floor(rand() * 4),
      initiallyMasked: rand() < 0.15,
    }));
    const evCount = Math.floor(rand() * 24);
    const events: ScheduledEvent[] = Array.from({ length: evCount }, () => {
      const kind = kinds[Math.floor(rand() * kinds.length)];
      const lineId = ids[Math.floor(rand() * n)];
      const at = 1 + Math.floor(rand() * 30);
      if (kind === 'setPriority') return { at, lineId, kind, priority: 1 + Math.floor(rand() * 6) };
      if (kind === 'setMode') return { at, lineId, kind, mode: rand() < 0.5 ? ('edge' as const) : ('level' as const) };
      return { at, lineId, kind };
    });

    const ref = new ReferenceMachine(lines, events);
    const refRecs: string[] = [];
    let rr = ref.step1();
    while (rr) {
      refRecs.push(normalize(rr as unknown as TickRecord));
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
  const trace = runReplay(
    [{ id: 'H', priority: 1, mode: 'level', handlerTicks: 2 }],
    [{ at: 1, lineId: 'H', kind: 'raise' }]
  );
  eq(trace.ticks.length, 500, '持续电平重入恰好在 500 tick 处停止');
  eq(trace.truncated, true, 'truncated = true 作为截断证据');
  eq(trace.ticks[499].tick, 500, '最后一个记录为 tick 500');
});

// ---------------------------------------------------------------------------
// 输入校验
// ---------------------------------------------------------------------------
describe('配置校验：1～8 线、唯一 ID、handlerTicks >= 1、越界事件告警', () => {
  ok(validateInput([], []).errors.length === 1, '0 条线被拒绝');
  ok(
    validateInput(
      Array.from({ length: 9 }, (_, i) => ({ id: 'X' + i, priority: 1, mode: 'edge' as const, handlerTicks: 1 })),
      []
    ).errors.length === 1,
    '9 条线被拒绝'
  );
  ok(
    validateInput(
      [
        { id: 'D', priority: 1, mode: 'edge', handlerTicks: 1 },
        { id: 'D', priority: 1, mode: 'edge', handlerTicks: 1 },
      ],
      []
    ).errors.length >= 1,
    '重复 ID 被拒绝'
  );
  ok(
    validateInput([{ id: 'E', priority: 1, mode: 'edge', handlerTicks: 0 }], []).errors.length >= 1,
    'handlerTicks=0 被拒绝'
  );
  ok(
    validateInput([{ id: 'E', priority: 1, mode: 'edge', handlerTicks: 1 }], [
      { at: 501, lineId: 'E', kind: 'raise' },
    ]).warnings.length === 1,
    'tick>500 的事件产生告警'
  );
});

// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
