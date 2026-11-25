// 发布与权限。
//
// 规则要点：
//   - 合作方按货类/区域权限看数；公开报表不受限。
//   - 明细附带受 index_policy 级别门槛约束：甲=开行路线，乙=站点级，未定级仅合计。
//   - 一个细分线记录重新归类可保持总指数/总级别不变，却改变哪个合作方收到哪些线路。
//   - 未送达的表在归属更正后按当前可比范围重出（revision 递增并写明原因）；
//     已确认收到的表保留原版与修订原因，不向无权限合作方补发更正明细。
//   - 合作方只收到自身范围的小计，绝不附带全局合计或可反推受限小计的补数。
//   - 行业简报的总数必须能与同版细分资料逐关系核对（reconcile）。
import { num } from './io.js'
import { expandGroup, stationRow } from './frames.js'
import { gradeFor, summarizeBasket } from './index.js'
import { STATUS } from './reachability.js'

// 解析权限：公开 / "<区域><货类>" / "受限<货类>"
export function parsePermission(reportRow) {
  if (reportRow.permission === '公开') {
    return { public: true, regions: null, cargo: null }
  }
  const cargoes = ['杂货', '木材', '散货']
  const cargo = cargoes.find((name) => reportRow.permission.includes(name)) ?? null
  let regions = null
  if (reportRow.scope !== '全区') {
    regions = [reportRow.scope.replace('区', '')]
  }
  return { public: false, regions, cargo, restricted: reportRow.permission.startsWith('受限') }
}

// OD 发站群在某框架版本下，各区域由哪些分站承担（用于区域可见性与重新归类）
export function odRegionStations(frameIndex, version, canonical) {
  const group = expandGroup(frameIndex, version, canonical)
  return group.map((station) => ({
    station: station.station,
    regional: station.regional,
    share: station.share,
    frameCargo: station.frameCargo,
  }))
}

// 判断某合作方是否可见该 OD：货类匹配，且发站群或到站群在其区域内设有分站。
// 合作方按其区域内涉及的业务关系看数（无论该区域是发端还是到端）。
// 注意：frames.cargo 只是统计框架登记的主要货类，分站实际可办货类以运行图为准，
// 因此区域判断只看分站归属区域，不用框架货类二次过滤。
export function canSeeOd(permission, frameIndex, version, evaluation) {
  if (permission.public) return true
  if (permission.cargo !== evaluation.cargo) return false
  if (permission.regions === null) return true
  const touchedRegions = [
    ...odRegionStations(frameIndex, version, evaluation.origin),
    ...odRegionStations(frameIndex, version, evaluation.destination),
  ].map((station) => station.regional)
  return touchedRegions.some((region) => permission.regions.includes(region))
}

// 合作方可见的班线（开行路线明细）。路径里任一中间站也按区域权限过滤，
// 保证重新归类到无权限区域的线路不会泄漏。
export function visibleRoutes(permission, frameIndex, version, evaluation) {
  if (!canSeeOd(permission, frameIndex, version, evaluation)) return []
  if (permission.public) {
    return evaluation.journeys.map((journey) => journey.routes.join('+'))
  }
  const allowed = new Set(
    odRegionStations(frameIndex, version, evaluation.origin)
      .filter((station) => permission.regions.includes(station.regional))
      .map((station) => station.station),
  )
  const result = []
  for (const journey of evaluation.journeys) {
    // 起点分站必须在合作方区域内；该 OD 已通过 canSeeOd 的货类校验
    if (journey.stations.some((station, idx) => idx === 0 && !allowed.has(station))) continue
    result.push(journey.routes.join('+'))
  }
  return result
}

function detailAllowed(grade) {
  if (!grade || !grade.grade) return { level: 'aggregate_only', routes: false, stations: false }
  if (grade.detailed === '开行路线') return { level: 'route', routes: true, stations: true }
  if (grade.detailed === '站点级') return { level: 'station', routes: false, stations: true }
  return { level: 'aggregate_only', routes: false, stations: false }
}

// 构建单个报表的发布清单（不含修订决策，修订在 buildRelease 中处理）
export function buildManifest({
  reportRow,
  period,
  version,
  frameIndex,
  evaluations,
  policy,
  globalGrade,
  transferRevisions,
}) {
  const permission = parsePermission(reportRow)
  const visible = evaluations.filter((row) => canSeeOd(permission, frameIndex, version, row))
  const scopeSummary = summarizeBasket(visible)
  // 明细附带门控按整期全局级别（index_policy），合作方小篮子只决定可见范围与小计；
  // 同时保留该范围自身的指数与发站群数，供其范围内核对。
  const scopeGrade = gradeFor(scopeSummary.index, scopeSummary.originGroupCount, policy)
  const detail = detailAllowed(globalGrade)

  const relations = visible.map((row) => {
    const entry = {
      od: row.od,
      origin: row.origin,
      destination: row.destination,
      cargo: row.cargo,
      status: row.status,
      weight: num(row.weight),
      detailLevel: detail.level,
    }
    if (detail.stations) {
      entry.originStations = odRegionStations(frameIndex, version, row.origin).map((s) => ({
        station: s.station,
        regional: s.regional,
        share: s.share,
      }))
    }
    if (detail.routes) {
      entry.routes = visibleRoutes(permission, frameIndex, version, row)
    }
    return entry
  })

  return {
    report: reportRow.report,
    period,
    scope: reportRow.scope,
    recipient: reportRow.recipient,
    permission: reportRow.permission,
    grade: globalGrade.grade,
    scopeGrade: scopeGrade.grade,
    detailLevel: detail.level,
    aggregate: {
      index: scopeSummary.index,
      observedScopeIndex: scopeSummary.observedScopeIndex,
      observedCoverage: scopeSummary.observedCoverage,
      reachableWeight: scopeSummary.reachableWeight,
      totalWeight: scopeSummary.totalWeight,
      originGroupCount: scopeSummary.originGroupCount,
      relationCount: scopeSummary.relationCount,
    },
    // 只含自身范围；不出现全局合计或补数，杜绝反推受限小计
    relations,
    basedOnTransferRevisions: transferRevisions.map((row) => ({
      station: row.station,
      fromRoute: row.from_route,
      toRoute: row.to_route,
      state: row.state,
      reportedAt: row.reported_at,
    })),
  }
}

// 修订决策与最终发布安排。
// receipts: report_receipts 行；reportingRow.state: 待发/已送/已付阅。
export function planRelease({ reporting, receipts, manifests, correctionCutoff }) {
  const receiptByReport = new Map()
  for (const receipt of receipts) {
    if (!receiptByReport.has(receipt.report) || receipt.revision >= receiptByReport.get(receipt.report).revision) {
      receiptByReport.set(receipt.report, receipt)
    }
  }

  const plans = reporting.map((reportRow) => {
    const manifest = manifests.get(reportRow.report)
    const receipt = receiptByReport.get(reportRow.report) ?? null
    // 仅“收悉”确认实际送达；“待发送”回单表示尚未送达，可在发送前重出
    const acknowledged = receipt?.event === '收悉'
    const delivered = acknowledged || reportRow.state === '已付阅'
    const correctionAfterReceipt =
      acknowledged && manifest.basedOnTransferRevisions.some((rev) => rev.reportedAt > receipt.at)

    if (delivered && correctionAfterReceipt) {
      // 已确认收到：保留原版，登记修订原因；不向无权限合作方补发更正明细
      return {
        report: reportRow.report,
        recipient: reportRow.recipient,
        action: 'retain_original',
        revision: receipt.revision,
        receivedAt: receipt.at,
        retainedMaterial: receipt.material,
        revisionReason: '换装更正晚于收悉时点，原版留存；更正不向该收件方补发明细',
        pendingCorrections: manifest.basedOnTransferRevisions.filter((rev) => rev.reportedAt > receipt.at),
      }
    }

    if (!delivered) {
      // 尚未送达：按当前可比范围重出，修订号递增并写明原因
      const reissued = manifest.basedOnTransferRevisions.length > 0
      return {
        report: reportRow.report,
        recipient: reportRow.recipient,
        action: reissued ? 'reissue_current_scope' : 'issue_current_scope',
        revision: String(Number(reportRow.current) + (reissued ? 1 : 0)),
        manifest,
        revisionReason: reissued
          ? `归属/换装更正（截至 ${correctionCutoff}）后按当前可比范围重出`
          : null,
      }
    }

    // 已送达且无晚到更正：原版有效
    return {
      report: reportRow.report,
      recipient: reportRow.recipient,
      action: 'unchanged',
      revision: receipt?.revision ?? reportRow.current,
      receivedAt: receipt?.at ?? null,
    }
  })

  return plans
}

// 行业简报总数与同版细分资料对账：
// 公开总表逐关系的可达权重之和必须等于各合作方可见关系并集的对应权重，
// 且合作方清单不得包含其权限外关系。
export function reconcile(publicManifest, partnerManifests) {
  const publicReach = publicManifest.aggregate.reachableWeight
  const seen = new Map()
  const violations = []
  for (const manifest of partnerManifests) {
    for (const relation of manifest.relations) {
      const existing = seen.get(relation.od)
      if (existing && existing !== relation.status) {
        violations.push(`${relation.od}: 分表间状态不一致`)
      }
      seen.set(relation.od, relation.status)
    }
  }
  const publicStatuses = new Map(publicManifest.relations.map((row) => [row.od, row.status]))
  for (const [od, status] of seen) {
    if (publicStatuses.get(od) !== status) {
      violations.push(`${od}: 分表与总表状态不一致`)
    }
  }
  const partnerReachUnion = [...seen.entries()]
    .filter(([, status]) => status === STATUS.REACHABLE)
    .reduce((sum, [od]) => {
      const relation = publicManifest.relations.find((row) => row.od === od)
      return sum + (relation ? relation.weight : 0)
    }, 0)

  return {
    ok: violations.length === 0 && partnerReachUnion <= publicReach,
    publicReachableWeight: publicReach,
    partnerReachableWeightUnion: partnerReachUnion,
    violations,
  }
}

// 反推断检查：受限合作方清单中不得出现全局指标或其权限外的货类/区域关系。
// 传入完整评估记录用于权限复核（精简后的分表行缺少到站群等字段）。
export function antiInferenceCheck(manifest, permission, frameIndex, version, evaluations) {
  const leaks = []
  if ('globalTotal' in manifest || 'globalIndex' in manifest) {
    leaks.push('出现全局指标，可反推受限小计')
  }
  const evalByOd = new Map(evaluations.map((row) => [row.od, row]))
  for (const relation of manifest.relations) {
    const full = evalByOd.get(relation.od)
    if (!full || !canSeeOd(permission, frameIndex, version, full)) {
      leaks.push(`${relation.od}: 超出该合作方货类/区域权限`)
    }
  }
  return { ok: leaks.length === 0, leaks }
}

// 供追溯使用：班线 -> 当期分站 -> canonical 货场群
export function routeToStationInfo(frameIndex, version, routeRow) {
  return {
    route: routeRow.route,
    from: {
      station: routeRow.from_station,
      frame: stationRow(frameIndex, version, routeRow.from_station),
    },
    to: {
      station: routeRow.to_station,
      frame: stationRow(frameIndex, version, routeRow.to_station),
    },
  }
}
