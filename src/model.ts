/**
 * 中断控制器回放 —— 数据模型定义。
 * 该模块不依赖任何硬件接口与 DOM，可同时用于页面渲染与测试。
 */

/** 触发模式：edge = 边沿触发，level = 电平触发。 */
export type TriggerMode = 'edge' | 'level';

/** 外部可注入的事件类型。 */
export type EventKind =
  | 'raise' // 边沿：触发一次；电平：把输入线拉高（保持有效）
  | 'lower' // 仅电平：撤销电平（输入线拉低）
  | 'mask' // 屏蔽：禁止该线被调度（边沿待处理位保留）
  | 'unmask' // 解除屏蔽：线重新允许被调度
  | 'setPriority' // 在阶段 A 调整该线后续调度的优先级
  | 'setMode'; // 在阶段 A 切换触发模式

/** 一条中断线的静态配置。 */
export interface LineConfig {
  /** 唯一 ID（非空字符串，全部线之间不可重复）。 */
  id: string;
  /** 优先级，数字越大优先级越高。 */
  priority: number;
  /** 边沿 / 电平模式。 */
  mode: TriggerMode;
  /** 处理程序从进入到完成需要的 tick 数（>= 1）。 */
  handlerTicks: number;
  /** 初始是否处于屏蔽状态，默认 false。 */
  initiallyMasked?: boolean;
}

/** 外部事件：在 tick 等于 at 的时刻（阶段 A）按列表顺序应用。 */
export interface ScheduledEvent {
  at: number;
  lineId: string;
  kind: EventKind;
  priority?: number;
  mode?: TriggerMode;
}

/** 内部待处理条目（待处理证据）。 */
export interface PendingInfo {
  lineId: string;
  /** 待处理位最早置位的 tick；同优先级时先到先处理。 */
  since: number;
  /** 合并的触发次数（边沿屏蔽期间重复触发会合并为 1 位）。 */
  hits: number;
  kind: 'edge' | 'level';
}

/** 执行栈中的一帧。 */
export interface FrameInfo {
  lineId: string;
  /** 处理程序总共需要的 tick 数。 */
  total: number;
  /** 从被抢占的 tick 累计已执行的 tick 数（完成时等于 total）。 */
  elapsed: number;
  /** 本帧进入（enter）时的 tick。 */
  enteredAt: number;
  /** 该帧之后是否已有更高优先级帧压入（用于区分 resume / continue）。 */
  preempted: boolean;
}

/** 单条执行日志（时间轴与表格共用同一条轨迹）。 */
export interface TraceLog {
  tick: number;
  /**
   * enter：处理程序进入；preempt：当前程序被更高优先级线抢占；
   * resume：被抢占帧在抢占者完成后恢复执行；continue：帧正常继续执行；
   * complete：处理完成；event：外部事件被应用。
   */
  type: 'enter' | 'preempt' | 'resume' | 'continue' | 'complete' | 'event';
  lineId?: string;
  /** 关联事件（type === 'event' 时）。 */
  eventKind?: EventKind;
  detail: string;
}

/** 单个 tick 的完整快照（逐 tick 参考状态机核对的单位）。 */
export interface TickRecord {
  tick: number;
  /** 阶段 A 应用的事件（保持输入顺序）。 */
  eventsApplied: Array<{ lineId: string; kind: EventKind; priority?: number; mode?: TriggerMode }>;
  /** 阶段 B 的完成（本 tick 最多一个）。 */
  completed?: { lineId: string };
  /** 阶段 C/D：本 tick CPU 实际动作。 */
  action:
    | { type: 'enter'; lineId: string }
    | { type: 'preempt'; by: string; resumed: string }
    | { type: 'resume'; lineId: string }
    | { type: 'continue'; lineId: string }
    | { type: 'idle' };
  /** 本 tick 结束后（阶段 D 执行后）的执行栈，栈顶在末尾。 */
  stack: FrameInfo[];
  /** 本 tick 结束后的待处理位（已按 since、ID 排序）。 */
  pending: PendingInfo[];
  /** 本 tick 结束后的输入电平（仅 level 线为 true 时有条目）。 */
  levelAsserted: string[];
  /** 本 tick 结束后处于屏蔽状态的线。 */
  masked: string[];
  /** 本 tick 结束后栈顶帧剩余 tick（空闲时为 null）。 */
  topRemaining: number | null;
}

/** 一次完整回放的产物。 */
export interface Trace {
  ticks: TickRecord[];
  logs: TraceLog[];
  /** 是否因达到 500 tick 上限而被截断。 */
  truncated: boolean;
  /** 配置/事件层面的告警（不影响模拟，仅展示）。 */
  warnings: string[];
}

export const MAX_TICKS = 500;

/** 待处理位的标准排序：先按置位时刻，再按 ID。 */
export function comparePending(a: PendingInfo, b: PendingInfo): number {
  if (a.since !== b.since) return a.since - b.since;
  return a.lineId < b.lineId ? -1 : a.lineId > b.lineId ? 1 : 0;
}
