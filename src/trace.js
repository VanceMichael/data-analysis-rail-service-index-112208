// 追溯：把指数、OD、站场、回单、换装更正、报表与发出证据串成可回查的链路。
// 目标：分析员从一个下降的指数能回答——是哪段业务通不了、口径变动还是资料等待；
// 从站场名单能走到所属报表示例与发出证据。下一期运行图更换后入口仍按同一套函数工作。
import { lineage } from './frames.js'
import { relKey } from './index.js'
import { parseStamp } from './io.js'
import { STATUS } from './reachability.js'

// 单个 OD 的完整回查
export function traceOd({ od, period, evaluation, baselineRow, currentRow, transferHistory, receiptsForOd }) {
  const blockers = []
  if (evaluation.status !== STATUS.REACHABLE) {
    if (evaluation.journeys.length === 0) {
      blockers.push({ kind: 'network', detail: evaluation.reason })
    }
    if (evaluation.status === STATUS.PENDING) {
      blockers.push({ kind: 'awaiting_data', detail: evaluation.reason })
    }
    if (evaluation.status === STATUS.NOT_ACCEPTING) {
      blockers.push({ kind: 'acceptance', detail: evaluation.reason })
    }
  }

  return {
    od,
    period,
    relation: {
      origin: evaluation.origin,
      destination: evaluation.destination,
      cargo: evaluation.cargo,
    },
    status: evaluation.status,
    reason: evaluation.reason,
    frozenBaselineWeight: baselineRow ? Number(baselineRow.weight) : null,
    currentWeight: currentRow ? Number(currentRow.weight) : null,
    candidateJourneys: evaluation.journeys.map((journey) => ({
      routes: journey.routes.join('+'),
      stations: journey.stations,
    })),
    latestEvidence: evaluation.observation,
    evidenceHistory: evaluation.evidenceHistory,
    transferRevisions: transferHistory,
    blockers,
    receipts: receiptsForOd,
  }
}

// 站场（分站）-> canonical 沿革 -> 当期相关班线 -> 报表与发出证据
export function traceStation({ station, frames, schedules, transfers, reporting, receipts, versionByPeriod }) {
  const lineages = lineage(frames)
  const frameRows = frames.filter((row) => row.station === station)
  const canonicalGroups = [...new Set(frameRows.map((row) => row.canonical))]

  const groupHistory = canonicalGroups.map((canonical) => ({
    canonical,
    timeline: lineages.get(canonical) ?? [],
  }))

  const relatedRoutes = schedules
    .filter((row) => row.from_station === station || row.to_station === station)
    .map((row) => ({
      period: row.period,
      route: row.route,
      from: row.from_station,
      to: row.to_station,
      cargo: row.cargo,
      accept: row.accept,
      run: row.run,
      frameworkVersion: versionByPeriod.get(row.period),
    }))

  const relatedTransfers = transfers.filter((row) => row.station === station)

  // 站场所属报表：按区域/货类匹配的报表定义，及其收悉/待发证据
  const stationRegions = [...new Set(frameRows.map((row) => row.regional))]
  const stationCargoes = [...new Set(frameRows.map((row) => row.cargo))]
  const reportLinks = reporting
    .filter((reportRow) => {
      if (reportRow.permission === '公开') return true
      const regionOk = reportRow.scope === '全区' ||
        stationRegions.some((region) => reportRow.scope.startsWith(region))
      const cargoOk = stationCargoes.some((cargo) => reportRow.permission.includes(cargo))
      return regionOk && cargoOk
    })
    .map((reportRow) => ({
      report: reportRow.report,
      scope: reportRow.scope,
      recipient: reportRow.recipient,
      permission: reportRow.permission,
      state: reportRow.state,
      receipts: receipts.filter((receipt) => receipt.report === reportRow.report),
    }))

  return {
    station,
    canonicalGroups,
    groupHistory,
    frameRows,
    relatedRoutes,
    relatedTransfers,
    reportLinks,
  }
}

// 报表 -> 收悉/待发证据；标注晚于收悉的更正（决定保留原版还是重出）
export function traceReport({ reportRow, receipts, transferRevisions }) {
  const reportReceipts = receipts
    .filter((receipt) => receipt.report === reportRow.report)
    .sort((a, b) => parseStamp(a.at).seq - parseStamp(b.at).seq)
  const latestReceipt = reportReceipts.at(-1) ?? null
  const acknowledged = latestReceipt?.event === '收悉'
  // 换装行同时兼容原始字段 reported_at 与标准化字段 reportedAt
  const stampOf = (row) => row.reportedAt ?? row.reported_at
  const correctionsAfterReceipt = acknowledged
    ? transferRevisions.filter((rev) => stampOf(rev) > latestReceipt.at)
    : []

  return {
    report: reportRow.report,
    period: reportRow.period,
    scope: reportRow.scope,
    recipient: reportRow.recipient,
    permission: reportRow.permission,
    currentCaliber: reportRow.current,
    reportingState: reportRow.state,
    receipts: reportReceipts,
    latestReceipt,
    correctionsAfterReceipt,
    disposition:
      acknowledged && correctionsAfterReceipt.length > 0
        ? 'retain_original_with_revision_note'
        : acknowledged
          ? 'delivered_unchanged'
          : 'not_delivered_reissue_before_send',
  }
}

// 指数下降的归因汇总：真实服务损失 / 覆盖或口径变化 / 资料等待
export function explainIndexDrop(prevIndex, currIndex, comparison, decomposition) {
  return {
    prevIndex: prevIndex.contractBasket.index,
    currIndex: currIndex.contractBasket.index,
    delta: decomposition.indexDelta,
    serviceLoss: decomposition.serviceDrivers.filter((driver) => driver.kind === 'service_loss'),
    serviceGain: decomposition.serviceDrivers.filter((driver) => driver.kind === 'service_gain'),
    pendingOrCoverage: decomposition.coverageChanges,
    commonScope: {
      relationCount: comparison.comparableRelations.length,
      commonWeight: comparison.commonWeight,
      prevIndexOnCommon: comparison.prevIndexOnCommon,
      currIndexOnCommon: comparison.currIndexOnCommon,
    },
    explanation:
      'serviceLoss 为共同可识别范围内真正不通的业务段；serviceGain 为真实改善；' +
      'pendingOrCoverage 是口径/覆盖变化或等待资料，不得归作基期范围服务改善',
  }
}

export { relKey }
