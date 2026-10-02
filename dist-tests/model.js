/**
 * 中断控制器回放 —— 数据模型定义。
 * 该模块不依赖任何硬件接口与 DOM，可同时用于页面渲染与测试。
 */
export const MAX_TICKS = 500;
/** 待处理位的标准排序：先按置位时刻，再按 ID。 */
export function comparePending(a, b) {
    if (a.since !== b.since)
        return a.since - b.since;
    return a.lineId < b.lineId ? -1 : a.lineId > b.lineId ? 1 : 0;
}
