/** 页面预置演示配置与事件。 */

import { LineConfig, ScheduledEvent } from './model';

export interface Demo {
  name: string;
  description: string;
  lines: LineConfig[];
  events: ScheduledEvent[];
}

export const DEMOS: Demo[] = [
  {
    name: '三层嵌套抢占',
    description: '低优先级 A 运行中先后被 B、C 抢占；C、B 依次完成后 A 恢复，被抢占的 tick 不消耗处理时间。',
    lines: [
      { id: 'A', priority: 1, mode: 'edge', handlerTicks: 4 },
      { id: 'B', priority: 2, mode: 'edge', handlerTicks: 2 },
      { id: 'C', priority: 3, mode: 'edge', handlerTicks: 1 },
    ],
    events: [
      { at: 1, lineId: 'A', kind: 'raise' },
      { at: 2, lineId: 'B', kind: 'raise' },
      { at: 3, lineId: 'C', kind: 'raise' },
    ],
  },
  {
    name: '同优先级排队（since + ID）',
    description: 'Y、X 同一 tick 触发，按 ID 先执行 X；Z 从 tick2 起等待，最后按 since 顺序处理。',
    lines: [
      { id: 'X', priority: 2, mode: 'edge', handlerTicks: 1 },
      { id: 'Y', priority: 2, mode: 'edge', handlerTicks: 1 },
      { id: 'Z', priority: 2, mode: 'edge', handlerTicks: 2 },
    ],
    events: [
      { at: 1, lineId: 'Y', kind: 'raise' },
      { at: 1, lineId: 'X', kind: 'raise' },
      { at: 2, lineId: 'Z', kind: 'raise' },
    ],
  },
  {
    name: '边沿屏蔽保留 + 重复合并',
    description: 'E 在屏蔽期间被触发 3 次，只保留 1 个待处理位（hits=3），解除屏蔽后仅执行一次。',
    lines: [{ id: 'E', priority: 1, mode: 'edge', handlerTicks: 1 }],
    events: [
      { at: 1, lineId: 'E', kind: 'mask' },
      { at: 2, lineId: 'E', kind: 'raise' },
      { at: 3, lineId: 'E', kind: 'raise' },
      { at: 3, lineId: 'E', kind: 'raise' },
      { at: 4, lineId: 'E', kind: 'unmask' },
    ],
  },
  {
    name: '电平重入 + 屏蔽/解除',
    description: '电平线 L 持续有效时处理完成即重入；随后屏蔽使其挂起，解除屏蔽后凭仍有效的电平再次进入。',
    lines: [{ id: 'L', priority: 1, mode: 'level', handlerTicks: 2 }],
    events: [
      { at: 1, lineId: 'L', kind: 'raise' },
      { at: 4, lineId: 'L', kind: 'lower' },
      { at: 5, lineId: 'L', kind: 'raise' },
      { at: 7, lineId: 'L', kind: 'mask' },
      { at: 9, lineId: 'L', kind: 'unmask' },
      { at: 10, lineId: 'L', kind: 'lower' },
    ],
  },
  {
    name: '切模式 + 同 tick 调级',
    description:
      'A 先屏蔽并边沿触发，t3 改为电平并解除屏蔽：旧边沿待处理位仍执行一次；同 tick 把运行中的 B 从 p3 降到 p1，等待的 C(p2) 在调级当 tick 不抢占（门槛冻结），B 跑完后依次执行 A、C。',
    lines: [
      { id: 'A', priority: 2, mode: 'edge', handlerTicks: 2 },
      { id: 'B', priority: 3, mode: 'edge', handlerTicks: 4 },
      { id: 'C', priority: 2, mode: 'edge', handlerTicks: 1 },
    ],
    events: [
      { at: 1, lineId: 'A', kind: 'mask' },
      { at: 1, lineId: 'A', kind: 'raise' },
      { at: 2, lineId: 'B', kind: 'raise' },
      { at: 2, lineId: 'C', kind: 'raise' },
      { at: 3, lineId: 'A', kind: 'setMode', mode: 'level' },
      { at: 3, lineId: 'A', kind: 'unmask' },
      { at: 3, lineId: 'B', kind: 'setPriority', priority: 1 },
    ],
  },
];
