// src/model.ts
var MAX_TICKS = 500;
function comparePending(a, b) {
  if (a.since !== b.since) return a.since - b.since;
  return a.lineId < b.lineId ? -1 : a.lineId > b.lineId ? 1 : 0;
}

// src/simulator.ts
function validateInput(lines, events) {
  const errors = [];
  const warnings = [];
  if (lines.length < 1 || lines.length > 8) {
    errors.push(`\u4E2D\u65AD\u7EBF\u6570\u91CF\u5FC5\u987B\u5728 1\uFF5E8 \u4E4B\u95F4\uFF0C\u5F53\u524D\u4E3A ${lines.length} \u6761\u3002`);
  }
  const ids = /* @__PURE__ */ new Set();
  for (const ln of lines) {
    if (!ln.id || !ln.id.trim()) errors.push("\u5B58\u5728\u7A7A ID \u7684\u4E2D\u65AD\u7EBF\u3002");
    if (ids.has(ln.id)) errors.push(`\u4E2D\u65AD\u7EBF ID \u91CD\u590D\uFF1A${ln.id}`);
    ids.add(ln.id);
    if (!Number.isInteger(ln.priority)) errors.push(`\u7EBF ${ln.id} \u7684\u4F18\u5148\u7EA7\u5FC5\u987B\u662F\u6574\u6570\u3002`);
    if (!Number.isInteger(ln.handlerTicks) || ln.handlerTicks < 1) {
      errors.push(`\u7EBF ${ln.id} \u7684 handlerTicks \u5FC5\u987B\u662F >= 1 \u7684\u6574\u6570\u3002`);
    }
    if (ln.mode !== "edge" && ln.mode !== "level") {
      errors.push(`\u7EBF ${ln.id} \u7684\u6A21\u5F0F\u5FC5\u987B\u662F edge \u6216 level\u3002`);
    }
  }
  for (const ev of events) {
    if (!ids.has(ev.lineId)) {
      errors.push(`tick ${ev.at} \u7684\u4E8B\u4EF6\u5F15\u7528\u4E86\u4E0D\u5B58\u5728\u7684\u7EBF\uFF1A${ev.lineId}`);
    }
    if (!Number.isInteger(ev.at) || ev.at < 1) {
      errors.push(`\u7EBF ${ev.lineId} \u5B58\u5728\u975E\u6CD5 tick\uFF08\u9700\u4E3A >= 1 \u7684\u6574\u6570\uFF09\uFF1A${ev.at}`);
    }
    if (ev.at > MAX_TICKS) {
      warnings.push(`tick ${ev.at} \u8D85\u51FA ${MAX_TICKS} tick \u56DE\u653E\u7A97\u53E3\uFF0C\u8BE5\u4E8B\u4EF6\u6C38\u8FDC\u4E0D\u4F1A\u88AB\u5E94\u7528\u3002`);
    }
    if (ev.kind === "setPriority" && !Number.isInteger(ev.priority)) {
      errors.push(`tick ${ev.at} \u7684\u4F18\u5148\u7EA7\u8C03\u6574\u7F3A\u5C11\u6574\u6570 priority\uFF1A${ev.lineId}`);
    }
    if (ev.kind === "setMode" && ev.mode !== "edge" && ev.mode !== "level") {
      errors.push(`tick ${ev.at} \u7684\u6A21\u5F0F\u8C03\u6574\u5FC5\u987B\u6307\u5B9A edge \u6216 level\uFF1A${ev.lineId}`);
    }
    const cfg = lines.find((l) => l.id === ev.lineId);
    if (cfg?.mode === "edge" && ev.kind === "lower") {
      warnings.push(`tick ${ev.at}\uFF1A\u8FB9\u6CBF\u7EBF ${ev.lineId} \u7684 lower \u4E8B\u4EF6\u65E0\u610F\u4E49\uFF0C\u5DF2\u5FFD\u7565\u3002`);
    }
  }
  return { errors, warnings };
}
var ReplayController = class {
  constructor(lines, events, warnings = []) {
    this.lastTick = 0;
    this.truncated = false;
    this.logs = [];
    this.ticks = [];
    this.state = {
      cfg: new Map(lines.map((l) => [l.id, l])),
      pending: [],
      levelAsserted: /* @__PURE__ */ new Set(),
      masked: new Set(lines.filter((l) => l.initiallyMasked).map((l) => l.id)),
      stack: [],
      runningIds: /* @__PURE__ */ new Set()
    };
    this.eventsByTick = /* @__PURE__ */ new Map();
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
    if (this.state.stack.length > 0) return true;
    for (const key of this.eventsByTick.keys()) {
      if (key > tick) return true;
    }
    return this.runnablePending().length > 0;
  }
  /** 推进一个 tick；没有任何剩余工作时返回 null。 */
  step() {
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
  advance(n) {
    const out = [];
    for (let i = 0; i < n; i++) {
      const rec = this.step();
      if (!rec) break;
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
      case "raise": {
        if (line.mode === "edge") {
          if (existing) {
            existing.hits += 1;
          } else {
            pending.push({ lineId: line.id, since: tick, hits: 1, kind: "edge" });
          }
        } else {
          levelAsserted.add(line.id);
          if (!masked.has(line.id) && !runningIds.has(line.id) && !existing) {
            pending.push({ lineId: line.id, since: tick, hits: 1, kind: "level" });
          }
        }
        break;
      }
      case "lower": {
        if (line.mode === "level") {
          levelAsserted.delete(line.id);
          if (!runningIds.has(line.id)) {
            const idx = pending.findIndex((p) => p.lineId === line.id && p.kind === "level");
            if (idx >= 0) pending.splice(idx, 1);
          }
        }
        break;
      }
      case "mask": {
        masked.add(line.id);
        if (line.mode === "level" && !runningIds.has(line.id)) {
          const idx = pending.findIndex((p) => p.lineId === line.id && p.kind === "level");
          if (idx >= 0) pending.splice(idx, 1);
        }
        break;
      }
      case "unmask": {
        masked.delete(line.id);
        if (line.mode === "level" && levelAsserted.has(line.id) && !runningIds.has(line.id) && !pending.some((p) => p.lineId === line.id)) {
          pending.push({ lineId: line.id, since: tick, hits: 1, kind: "level" });
        }
        break;
      }
      case "setPriority": {
        cfg.set(line.id, { ...line, priority: ev.priority });
        break;
      }
      case "setMode": {
        if (ev.mode !== line.mode) {
          for (let i = pending.length - 1; i >= 0; i--) {
            if (pending[i].lineId === line.id) pending.splice(i, 1);
          }
          levelAsserted.delete(line.id);
        }
        cfg.set(line.id, { ...line, mode: ev.mode });
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
    return this.state.pending.filter((p) => !masked.has(p.lineId) && !runningIds.has(p.lineId)).sort((a, b) => {
      const pa = this.state.cfg.get(a.lineId).priority;
      const pb = this.state.cfg.get(b.lineId).priority;
      if (pa !== pb) return pb - pa;
      return comparePending(a, b);
    });
  }
  // ------------------------------------------------------------------
  // 单 tick
  // ------------------------------------------------------------------
  runTick(tick) {
    const eventsApplied = [];
    let completed;
    for (const ev of this.eventsByTick.get(tick) ?? []) {
      const cfg = this.state.cfg.get(ev.lineId);
      if (!cfg) continue;
      if (cfg.mode === "edge" && ev.kind === "lower") continue;
      this.applyEvent(ev, tick);
      eventsApplied.push(ev.kind === "setPriority" ? { lineId: ev.lineId, kind: ev.kind, priority: ev.priority } : ev.kind === "setMode" ? { lineId: ev.lineId, kind: ev.kind, mode: ev.mode } : { lineId: ev.lineId, kind: ev.kind });
      this.logs.push({
        tick,
        type: "event",
        lineId: ev.lineId,
        eventKind: ev.kind,
        detail: `tick ${tick} \u4E8B\u4EF6\uFF1A${ev.lineId} ${eventLabel(ev.kind)}${ev.kind === "setPriority" ? ` ${ev.priority}` : ""}`
      });
    }
    const top = this.state.stack[this.state.stack.length - 1];
    if (top && top.elapsed >= top.total) {
      this.state.stack.pop();
      this.state.runningIds.delete(top.lineId);
      completed = { lineId: top.lineId };
      this.logs.push({
        tick,
        type: "complete",
        lineId: top.lineId,
        detail: `tick ${tick} \u5B8C\u6210\uFF1A${top.lineId}\uFF08\u5171 ${top.total} tick\uFF09`
      });
      const cfg = this.state.cfg.get(top.lineId);
      if (cfg.mode === "level" && this.state.levelAsserted.has(top.lineId) && !this.state.masked.has(top.lineId) && !this.state.pending.some((p) => p.lineId === top.lineId)) {
        this.state.pending.push({ lineId: top.lineId, since: tick, hits: 1, kind: "level" });
      }
      const parent = this.state.stack[this.state.stack.length - 1];
      if (parent) parent.preempted = true;
    }
    const runnable = this.runnablePending();
    const winner = runnable[0];
    let action;
    const currentTop = this.state.stack[this.state.stack.length - 1];
    if (!currentTop) {
      if (winner) {
        this.enterFrame(winner, tick);
        action = { type: "enter", lineId: winner.lineId };
      } else {
        action = { type: "idle" };
      }
    } else if (winner && this.state.cfg.get(winner.lineId).priority > this.state.cfg.get(currentTop.lineId).priority) {
      currentTop.preempted = true;
      this.enterFrame(winner, tick);
      action = { type: "preempt", by: winner.lineId, resumed: currentTop.lineId };
      this.logs.push({
        tick,
        type: "preempt",
        lineId: winner.lineId,
        detail: `tick ${tick} \u62A2\u5360\uFF1A${winner.lineId}\uFF08\u4F18\u5148\u7EA7 ${this.state.cfg.get(winner.lineId).priority}\uFF09\u62A2\u5360 ${currentTop.lineId}\uFF08\u4F18\u5148\u7EA7 ${this.state.cfg.get(currentTop.lineId).priority}\uFF09\uFF0C\u540C\u4F18\u5148\u7EA7\u5019\u9009\u7EE7\u7EED\u7B49\u5F85`
      });
    } else if (currentTop.preempted) {
      action = { type: "resume", lineId: currentTop.lineId };
    } else {
      action = { type: "continue", lineId: currentTop.lineId };
    }
    const execTop = this.state.stack[this.state.stack.length - 1];
    if (execTop) {
      execTop.elapsed += 1;
      if (action.type === "enter") {
        this.logs.push({
          tick,
          type: "enter",
          lineId: execTop.lineId,
          detail: `tick ${tick} \u8FDB\u5165\uFF1A${execTop.lineId}\uFF08\u9700\u8981 ${execTop.total} tick\uFF09`
        });
      } else if (action.type === "preempt") {
        this.logs.push({
          tick,
          type: "enter",
          lineId: execTop.lineId,
          detail: `tick ${tick} \u8FDB\u5165\uFF1A${execTop.lineId}\uFF08\u62A2\u5360\u8FDB\u5165\uFF0C\u9700\u8981 ${execTop.total} tick\uFF09`
        });
      } else if (action.type === "resume") {
        this.logs.push({
          tick,
          type: "resume",
          lineId: execTop.lineId,
          detail: `tick ${tick} \u6062\u590D\uFF1A${execTop.lineId}\uFF08\u5DF2\u6267\u884C ${execTop.elapsed}/${execTop.total}\uFF09`
        });
        execTop.preempted = false;
      } else if (action.type === "continue") {
        this.logs.push({
          tick,
          type: "continue",
          lineId: execTop.lineId,
          detail: `tick ${tick} \u6267\u884C\uFF1A${execTop.lineId}\uFF08\u5DF2\u6267\u884C ${execTop.elapsed}/${execTop.total}\uFF09`
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
      topRemaining: execTop ? execTop.total - execTop.elapsed : null
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
      preempted: false
    });
    this.state.runningIds.add(p.lineId);
  }
};
function eventLabel(kind) {
  switch (kind) {
    case "raise":
      return "raise\uFF08\u89E6\u53D1/\u62C9\u9AD8\uFF09";
    case "lower":
      return "lower\uFF08\u64A4\u9500\u7535\u5E73\uFF09";
    case "mask":
      return "mask\uFF08\u5C4F\u853D\uFF09";
    case "unmask":
      return "unmask\uFF08\u89E3\u9664\u5C4F\u853D\uFF09";
    case "setPriority":
      return "setPriority\uFF08\u8C03\u6574\u4F18\u5148\u7EA7\uFF09";
    case "setMode":
      return "setMode\uFF08\u5207\u6362\u89E6\u53D1\u6A21\u5F0F\uFF09";
    default:
      return kind;
  }
}
function runReplay(lines, events) {
  const { errors, warnings } = validateInput(lines, events);
  if (errors.length > 0) {
    throw new Error("\u914D\u7F6E\u65E0\u6548\uFF1A\n" + errors.map((e) => " - " + e).join("\n"));
  }
  const ctrl = new ReplayController(lines, events, warnings);
  while (ctrl.step() !== null) {
  }
  return ctrl.toTrace();
}

// src/scenarios.ts
var DEMOS = [
  {
    name: "\u4E09\u5C42\u5D4C\u5957\u62A2\u5360",
    description: "\u4F4E\u4F18\u5148\u7EA7 A \u8FD0\u884C\u4E2D\u5148\u540E\u88AB B\u3001C \u62A2\u5360\uFF1BC\u3001B \u4F9D\u6B21\u5B8C\u6210\u540E A \u6062\u590D\uFF0C\u88AB\u62A2\u5360\u7684 tick \u4E0D\u6D88\u8017\u5904\u7406\u65F6\u95F4\u3002",
    lines: [
      { id: "A", priority: 1, mode: "edge", handlerTicks: 4 },
      { id: "B", priority: 2, mode: "edge", handlerTicks: 2 },
      { id: "C", priority: 3, mode: "edge", handlerTicks: 1 }
    ],
    events: [
      { at: 1, lineId: "A", kind: "raise" },
      { at: 2, lineId: "B", kind: "raise" },
      { at: 3, lineId: "C", kind: "raise" }
    ]
  },
  {
    name: "\u540C\u4F18\u5148\u7EA7\u6392\u961F\uFF08since + ID\uFF09",
    description: "Y\u3001X \u540C\u4E00 tick \u89E6\u53D1\uFF0C\u6309 ID \u5148\u6267\u884C X\uFF1BZ \u4ECE tick2 \u8D77\u7B49\u5F85\uFF0C\u6700\u540E\u6309 since \u987A\u5E8F\u5904\u7406\u3002",
    lines: [
      { id: "X", priority: 2, mode: "edge", handlerTicks: 1 },
      { id: "Y", priority: 2, mode: "edge", handlerTicks: 1 },
      { id: "Z", priority: 2, mode: "edge", handlerTicks: 2 }
    ],
    events: [
      { at: 1, lineId: "Y", kind: "raise" },
      { at: 1, lineId: "X", kind: "raise" },
      { at: 2, lineId: "Z", kind: "raise" }
    ]
  },
  {
    name: "\u8FB9\u6CBF\u5C4F\u853D\u4FDD\u7559 + \u91CD\u590D\u5408\u5E76",
    description: "E \u5728\u5C4F\u853D\u671F\u95F4\u88AB\u89E6\u53D1 3 \u6B21\uFF0C\u53EA\u4FDD\u7559 1 \u4E2A\u5F85\u5904\u7406\u4F4D\uFF08hits=3\uFF09\uFF0C\u89E3\u9664\u5C4F\u853D\u540E\u4EC5\u6267\u884C\u4E00\u6B21\u3002",
    lines: [{ id: "E", priority: 1, mode: "edge", handlerTicks: 1 }],
    events: [
      { at: 1, lineId: "E", kind: "mask" },
      { at: 2, lineId: "E", kind: "raise" },
      { at: 3, lineId: "E", kind: "raise" },
      { at: 3, lineId: "E", kind: "raise" },
      { at: 4, lineId: "E", kind: "unmask" }
    ]
  },
  {
    name: "\u7535\u5E73\u91CD\u5165 + \u5C4F\u853D/\u89E3\u9664",
    description: "\u7535\u5E73\u7EBF L \u6301\u7EED\u6709\u6548\u65F6\u5904\u7406\u5B8C\u6210\u5373\u91CD\u5165\uFF1B\u968F\u540E\u5C4F\u853D\u4F7F\u5176\u6302\u8D77\uFF0C\u89E3\u9664\u5C4F\u853D\u540E\u51ED\u4ECD\u6709\u6548\u7684\u7535\u5E73\u518D\u6B21\u8FDB\u5165\u3002",
    lines: [{ id: "L", priority: 1, mode: "level", handlerTicks: 2 }],
    events: [
      { at: 1, lineId: "L", kind: "raise" },
      { at: 4, lineId: "L", kind: "lower" },
      { at: 5, lineId: "L", kind: "raise" },
      { at: 7, lineId: "L", kind: "mask" },
      { at: 9, lineId: "L", kind: "unmask" },
      { at: 10, lineId: "L", kind: "lower" }
    ]
  },
  {
    name: "\u6A21\u5F0F\u5207\u6362 + \u8FD0\u884C\u4E2D\u8C03\u7EA7",
    description: "E \u5C4F\u853D\u671F\u5408\u5E76\u7684\u8FB9\u6CBF\u5F85\u5904\u7406\u4F4D\u5728\u5207\u6210\u7535\u5E73\u6A21\u5F0F\u65F6\u5931\u6548\uFF08\u4E0D\u51ED\u65E7\u4F4D\u8FDB\u5165\uFF09\uFF1BA \u8FD0\u884C\u4E2D\u88AB\u8C03\u4F4E\u4F18\u5148\u7EA7\u540E\uFF0C\u7B49\u5F85\u4E2D\u7684 B \u5F53 tick \u5373\u53EF\u62A2\u5360\u3002",
    lines: [
      { id: "E", priority: 1, mode: "edge", handlerTicks: 1 },
      { id: "A", priority: 3, mode: "edge", handlerTicks: 4 },
      { id: "B", priority: 2, mode: "edge", handlerTicks: 1 }
    ],
    events: [
      { at: 1, lineId: "E", kind: "mask" },
      { at: 1, lineId: "A", kind: "raise" },
      { at: 2, lineId: "E", kind: "raise" },
      { at: 2, lineId: "B", kind: "raise" },
      { at: 3, lineId: "A", kind: "setPriority", priority: 1 },
      { at: 4, lineId: "E", kind: "setMode", mode: "level" },
      { at: 4, lineId: "E", kind: "unmask" }
    ]
  }
];

// src/main.ts
var $ = (sel) => document.querySelector(sel);
var els = {
  demo: $("#demo"),
  desc: $("#desc"),
  linesJson: $("#linesJson"),
  eventsJson: $("#eventsJson"),
  load: $("#load"),
  reset: $("#reset"),
  step: $("#step"),
  step5: $("#step5"),
  runAll: $("#runAll"),
  errors: $("#errors"),
  warns: $("#warns"),
  chips: $("#chips"),
  tickNo: $("#tickNo"),
  remaining: $("#remaining"),
  stackView: $("#stackView"),
  pendingBox: $("#pendingBox"),
  levelBox: $("#levelBox"),
  maskBox: $("#maskBox"),
  timeline: $("#timeline"),
  tabs: document.querySelectorAll(".tabs button"),
  viewTimeline: $("#viewTimeline"),
  viewTable: $("#viewTable"),
  viewLogs: $("#viewLogs"),
  trunc: $("#trunc")
};
var config = null;
var controller = null;
var selectedTick = 0;
var LINE_COLORS = ["#5b9dff", "#3fb96b", "#e0a83d", "#ff6b6b", "#b07cf7", "#3fc9c0", "#ff8fcf", "#9dff5b"];
function lineColor(id) {
  if (!config) return "#888";
  const idx = config.lines.findIndex((l) => l.id === id);
  return LINE_COLORS[idx % LINE_COLORS.length];
}
for (const d of DEMOS) {
  const o = document.createElement("option");
  o.value = d.name;
  o.textContent = d.name;
  els.demo.appendChild(o);
}
els.demo.addEventListener("change", () => fillDemo(els.demo.selectedIndex - 1));
function fillDemo(i) {
  if (i < 0 || i >= DEMOS.length) return;
  const d = DEMOS[i];
  els.demo.selectedIndex = i + 1;
  els.desc.textContent = d.description;
  els.linesJson.value = JSON.stringify(d.lines, null, 2);
  els.eventsJson.value = JSON.stringify(d.events, null, 2);
}
function tryParse() {
  els.errors.textContent = "";
  els.warns.textContent = "";
  let lines;
  let events;
  try {
    lines = JSON.parse(els.linesJson.value);
  } catch (e) {
    els.errors.textContent = "\u4E2D\u65AD\u7EBF JSON \u89E3\u6790\u5931\u8D25\uFF1A" + e.message;
    return null;
  }
  try {
    events = JSON.parse(els.eventsJson.value);
  } catch (e) {
    els.errors.textContent = "\u4E8B\u4EF6 JSON \u89E3\u6790\u5931\u8D25\uFF1A" + e.message;
    return null;
  }
  const { errors, warnings } = validateInput(lines, events);
  if (errors.length) {
    els.errors.textContent = errors.map((e) => "\u2022 " + e).join("\n");
    return null;
  }
  if (warnings.length) els.warns.textContent = warnings.map((w) => "\u2022 " + w).join("\n");
  return { lines, events };
}
function loadConfig() {
  const cfg = tryParse();
  if (!cfg) return;
  config = cfg;
  controller = new ReplayController(cfg.lines, cfg.events, validateInput(cfg.lines, cfg.events).warnings);
  selectedTick = 0;
  renderChips();
  render();
}
els.load.addEventListener("click", loadConfig);
els.reset.addEventListener("click", () => {
  if (config) controller = new ReplayController(config.lines, config.events, controller?.warnings ?? []);
  selectedTick = 0;
  render();
});
els.step.addEventListener("click", () => {
  controller?.step();
  selectedTick = controller?.ticks.length ?? 0;
  render();
});
els.step5.addEventListener("click", () => {
  controller?.advance(5);
  selectedTick = controller?.ticks.length ?? 0;
  render();
});
els.runAll.addEventListener("click", () => {
  if (!config) return;
  while (controller.step() !== null) {
  }
  selectedTick = controller?.ticks.length ?? 0;
  render();
});
els.tabs.forEach(
  (b) => b.addEventListener("click", () => {
    els.tabs.forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    const v = b.dataset.view;
    els.viewTimeline.style.display = v === "timeline" ? "" : "none";
    els.viewTable.style.display = v === "table" ? "" : "none";
    els.viewLogs.style.display = v === "logs" ? "" : "none";
  })
);
function renderChips() {
  els.chips.innerHTML = "";
  if (!config) return;
  for (const l of config.lines) {
    const c = document.createElement("span");
    c.className = "chip";
    c.innerHTML = `<b style="color:${lineColor(l.id)}">${l.id}</b> \xB7 p${l.priority} \xB7 ${l.mode === "edge" ? "\u8FB9\u6CBF" : "\u7535\u5E73"} \xB7 ${l.handlerTicks}t${l.initiallyMasked ? " \xB7 \u5DF2\u5C4F\u853D" : ""}`;
    els.chips.appendChild(c);
  }
}
function currentRecord() {
  if (!controller || controller.ticks.length === 0) return null;
  const idx = selectedTick > 0 ? selectedTick - 1 : controller.ticks.length - 1;
  return controller.ticks[Math.min(idx, controller.ticks.length - 1)] ?? null;
}
function renderState(rec) {
  els.tickNo.textContent = rec ? String(rec.tick) : controller ? "0\uFF08\u672A\u5F00\u59CB\uFF09" : "\u2014";
  if (!rec) {
    els.stackView.innerHTML = '<span class="hint">\u65E0\u6267\u884C\u5E27</span>';
    els.pendingBox.innerHTML = '<span class="hint">\u2014</span>';
    els.levelBox.innerHTML = '<span class="hint">\u2014</span>';
    els.maskBox.innerHTML = '<span class="hint">\u2014</span>';
    els.remaining.textContent = "\u2014";
    return;
  }
  els.remaining.textContent = rec.topRemaining === null ? "\u7A7A\u95F2" : `${rec.topRemaining} tick`;
  els.stackView.innerHTML = "";
  if (rec.stack.length === 0) {
    els.stackView.innerHTML = '<span class="hint">CPU \u7A7A\u95F2</span>';
  }
  rec.stack.forEach((f, i) => {
    const cfg = config.lines.find((l) => l.id === f.lineId);
    const top = i === rec.stack.length - 1;
    const pct = Math.round(f.elapsed / f.total * 100);
    const div = document.createElement("div");
    div.className = "frame" + (top ? " top" : "");
    div.style.borderLeftColor = lineColor(f.lineId);
    div.innerHTML = `
      <div style="flex:1">
        <b style="color:${lineColor(f.lineId)}">${f.lineId}</b>
        <span class="mono2"> p${cfg.priority} \xB7 ${cfg.mode === "edge" ? "\u8FB9\u6CBF" : "\u7535\u5E73"}</span>
        <div class="bar"><i style="width:${pct}%;background:${lineColor(f.lineId)}"></i></div>
      </div>
      <div class="mono2" style="white-space:nowrap">${f.elapsed}/${f.total} tick</div>`;
    els.stackView.appendChild(div);
  });
  els.pendingBox.innerHTML = rec.pending.length ? rec.pending.map(
    (p) => `<span class="pill ${p.kind}" style="border-color:${lineColor(p.lineId)}">${p.lineId} \xB7 since t${p.since} \xB7 \xD7${p.hits}</span>`
  ).join("") : '<span class="hint">\u65E0\u5F85\u5904\u7406\u4F4D</span>';
  els.levelBox.innerHTML = rec.levelAsserted.length ? rec.levelAsserted.map((id) => `<span class="pill level" style="border-color:${lineColor(id)}">${id} \u7535\u5E73\u6709\u6548</span>`).join("") : '<span class="hint">\u65E0\u6709\u6548\u7535\u5E73</span>';
  els.maskBox.innerHTML = rec.masked.length ? rec.masked.map((id) => `<span class="pill mask" style="border-color:${lineColor(id)}">${id} \u5C4F\u853D\u4E2D</span>`).join("") : '<span class="hint">\u65E0\u5C4F\u853D</span>';
}
function actionTag(r) {
  switch (r.action.type) {
    case "enter":
      return { text: "\u8FDB\u5165", cls: "enter", color: "var(--enter)" };
    case "preempt":
      return { text: `\u62A2\u2192${r.action.by}`, cls: "preempt", color: "var(--preempt)" };
    case "resume":
      return { text: "\u6062\u590D", cls: "resume", color: "var(--resume)" };
    case "continue":
      return { text: "\u6267", cls: "continue", color: "var(--continue)" };
    case "idle":
      return { text: "\xB7", cls: "idle", color: "var(--idle)" };
  }
}
function eventsAt(t) {
  const m = /* @__PURE__ */ new Map();
  const rec = controller?.ticks[t - 1];
  if (rec) for (const e of rec.eventsApplied) m.set(e.lineId, e.kind);
  return m;
}
function renderTimeline() {
  if (!controller || !config) {
    els.timeline.innerHTML = '<p class="hint">\u8F7D\u5165\u914D\u7F6E\u540E\u663E\u793A\u65F6\u95F4\u8F74\u3002</p>';
    return;
  }
  const ticks = controller.ticks;
  const last = Math.max(ticks.length, 1);
  let html = '<div class="timeline-wrap"><table class="timeline">';
  html += '<tr><th style="width:80px;min-width:80px;position:sticky;left:0;z-index:2;background:var(--panel)">tick</th>';
  for (let t = 1; t <= last; t++) html += `<th>${t}</th>`;
  html += "</tr>";
  html += '<tr><td style="position:sticky;left:0;background:var(--panel);font-size:10px;color:var(--muted)">CPU \u52A8\u4F5C</td>';
  for (let t = 1; t <= last; t++) {
    const r = ticks[t - 1];
    const tag = r ? actionTag(r) : null;
    const sel = selectedTick === t ? " selected" : "";
    html += `<td class="cell idle${sel}" data-tick="${t}" style="${tag && tag.cls !== "idle" ? `color:${tag.color}` : ""}">${tag ? tag.text : ""}</td>`;
  }
  html += "</tr>";
  for (const line of config.lines) {
    const color = lineColor(line.id);
    html += `<tr><td style="position:sticky;left:0;background:var(--panel);font-size:10px"><b style="color:${color}">${line.id}</b> <span class="mono2">p${line.priority}</span></td>`;
    for (let t = 1; t <= last; t++) {
      const r = ticks[t - 1];
      const ev = r ? eventsAt(t).get(line.id) : void 0;
      let bg = "";
      let content = "";
      let title = "";
      if (r) {
        const onStack = r.stack.some((f) => f.lineId === line.id);
        const top = r.stack[r.stack.length - 1];
        const isTop = top && top.lineId === line.id;
        const pend = r.pending.find((p) => p.lineId === line.id);
        if (onStack) {
          bg = isTop ? `background:${color}55;box-shadow:inset 0 0 0 1px ${color}` : `background:${color}22`;
          content = isTop ? "\u25B6" : "\u2225";
          title = isTop ? "\u6B63\u5728\u6267\u884C" : "\u88AB\u62A2\u5360\u6302\u8D77";
        } else if (pend) {
          content = `P${pend.hits > 1 ? pend.hits : ""}`;
          title = `\u5F85\u5904\u7406 since t${pend.since}\uFF0C\u5408\u5E76 ${pend.hits} \u6B21`;
        } else if (line.mode === "level" && r.levelAsserted.includes(line.id)) {
          content = "~";
          title = "\u8F93\u5165\u7535\u5E73\u6709\u6548";
        }
        if (r.completed?.lineId === line.id) {
          content = "\u25A0";
          title = "\u672C tick \u5904\u7406\u5B8C\u6210\uFF08\u4E0A\u4E00 tick \u6267\u884C\u6536\u5C3E\uFF09";
        }
      }
      const evCls = ev ? ` ev-${ev}` : "";
      const sel = selectedTick === t ? " selected" : "";
      html += `<td class="cell${evCls}${sel}" data-tick="${t}" style="${bg}" title="t${t} ${line.id}\uFF1A${title}${ev ? "\uFF1B\u4E8B\u4EF6 " + ev : ""}">${content}</td>`;
    }
    html += "</tr>";
  }
  html += "</table></div>";
  els.timeline.innerHTML = html;
  els.timeline.querySelectorAll("td.cell").forEach((td) => {
    td.addEventListener("click", () => selectTick(Number(td.dataset.tick)));
  });
}
function renderTable() {
  if (!controller || !config) {
    els.viewTable.innerHTML = '<p class="hint">\u8F7D\u5165\u914D\u7F6E\u540E\u663E\u793A\u9010 tick \u8BB0\u5F55\u3002</p>';
    return;
  }
  let html = '<table class="records"><tr><th>tick</th><th>\u4E8B\u4EF6(\u9636\u6BB5A)</th><th>\u5B8C\u6210(\u9636\u6BB5B)</th><th>\u52A8\u4F5C(\u9636\u6BB5C/D)</th><th>\u6267\u884C\u6808\uFF08\u5E95\u2192\u9876\uFF09</th><th>\u5F85\u5904\u7406\u8BC1\u636E</th></tr>';
  for (const r of controller.ticks) {
    const evs = r.eventsApplied.length ? r.eventsApplied.map(
      (e) => `<span class="tag event">${e.lineId}\xB7${eventZh(e.kind)}${e.kind === "setPriority" ? `\u2192p${e.priority}` : e.kind === "setMode" ? `\u2192${e.mode === "edge" ? "\u8FB9\u6CBF" : "\u7535\u5E73"}` : ""}</span>`
    ).join(" ") : '<span class="mono2">\u2014</span>';
    const comp = r.completed ? `<span class="tag complete">${r.completed.lineId} \u5B8C\u6210</span>` : '<span class="mono2">\u2014</span>';
    let actionDesc;
    if (r.action.type === "preempt")
      actionDesc = `<span class="tag preempt">\u62A2\u5360</span> ${r.action.by} \u62A2\u5360 ${r.action.resumed}`;
    else if (r.action.type === "enter")
      actionDesc = `<span class="tag enter">\u8FDB\u5165</span> ${r.action.lineId}\uFF08\u5269\u4F59 ${r.topRemaining}\uFF09`;
    else if (r.action.type === "resume")
      actionDesc = `<span class="tag resume">\u6062\u590D</span> ${r.action.lineId}\uFF08\u5269\u4F59 ${r.topRemaining}\uFF09`;
    else if (r.action.type === "continue")
      actionDesc = `<span class="tag continue">\u6267\u884C</span> ${r.action.lineId}\uFF08\u5269\u4F59 ${r.topRemaining}\uFF09`;
    else actionDesc = '<span class="tag idle">\u7A7A\u95F2</span>';
    const stack = r.stack.length ? r.stack.map((f) => {
      const top = f === r.stack[r.stack.length - 1];
      return `<span style="color:${lineColor(f.lineId)}">${top ? "\u25B6" : "\u2225"}${f.lineId}(${f.elapsed}/${f.total})</span>`;
    }).join(" \u2190 ") : '<span class="mono2">\u2205</span>';
    const pend = r.pending.length ? r.pending.map((p) => `<span class="pill ${p.kind}" style="border-color:${lineColor(p.lineId)}">${p.lineId} since t${p.since} \xD7${p.hits}</span>`).join(" ") : '<span class="mono2">\u2205</span>';
    html += `<tr class="${selectedTick === r.tick ? "hl" : ""}" data-tick="${r.tick}">
      <td>${r.tick}</td><td>${evs}</td><td>${comp}</td><td>${actionDesc}</td><td>${stack}</td><td>${pend}</td></tr>`;
  }
  html += "</table>";
  els.viewTable.innerHTML = html;
  els.viewTable.querySelectorAll("tr[data-tick]").forEach((tr) => {
    tr.addEventListener("click", () => selectTick(Number(tr.dataset.tick)));
  });
}
function renderLogs() {
  if (!controller) {
    els.viewLogs.innerHTML = '<p class="hint">\u8F7D\u5165\u914D\u7F6E\u540E\u663E\u793A\u6267\u884C\u65E5\u5FD7\u3002</p>';
    return;
  }
  let html = '<table class="records"><tr><th>tick</th><th>\u7C7B\u578B</th><th>\u8BF4\u660E</th></tr>';
  for (const log of controller.logs) {
    const cls = log.type;
    html += `<tr class="${selectedTick === log.tick ? "hl" : ""}" data-tick="${log.tick}">
      <td>${log.tick}</td><td><span class="tag ${cls}">${logZh(log.type)}</span></td>
      <td>${log.detail}</td></tr>`;
  }
  html += "</table>";
  els.viewLogs.innerHTML = html;
  els.viewLogs.querySelectorAll("tr[data-tick]").forEach((tr) => {
    tr.addEventListener("click", () => selectTick(Number(tr.dataset.tick)));
  });
}
function eventZh(k) {
  switch (k) {
    case "raise":
      return "\u89E6\u53D1/\u62C9\u9AD8";
    case "lower":
      return "\u64A4\u9500\u7535\u5E73";
    case "mask":
      return "\u5C4F\u853D";
    case "unmask":
      return "\u89E3\u9664\u5C4F\u853D";
    case "setPriority":
      return "\u8C03\u4F18\u5148\u7EA7";
    case "setMode":
      return "\u5207\u6A21\u5F0F";
  }
}
function logZh(t) {
  return { enter: "\u8FDB\u5165", preempt: "\u62A2\u5360", resume: "\u6062\u590D", continue: "\u6267\u884C", complete: "\u5B8C\u6210", event: "\u4E8B\u4EF6", idle: "\u7A7A\u95F2" }[t] ?? t;
}
function selectTick(t) {
  selectedTick = t;
  render();
  const active = document.querySelector(".tabs button.active")?.dataset.view;
  const root = active === "logs" ? els.viewLogs : els.viewTable;
  const row = root.querySelector(`tr[data-tick="${t}"]`);
  row?.scrollIntoView({ block: "nearest" });
}
function render() {
  const rec = currentRecord();
  renderState(rec);
  renderTimeline();
  renderTable();
  renderLogs();
  els.trunc.style.display = controller?.isTruncated ? "" : "none";
  els.trunc.textContent = "\u26A0 \u5DF2\u8FBE\u5230 500 tick \u56DE\u653E\u4E0A\u9650\uFF0C\u8F68\u8FF9\u88AB\u622A\u65AD\uFF08\u4ECD\u6709\u672A\u5B8C\u6210\u5DE5\u4F5C\uFF09\u3002";
  if (selectedTick > (controller?.ticks.length ?? 0)) selectedTick = controller?.ticks.length ?? 0;
}
fillDemo(0);
loadConfig();
window.runReplay = runReplay;
