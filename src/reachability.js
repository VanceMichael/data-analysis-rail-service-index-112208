// 月度可达性判定。
// 一个托运起讫关系（OD，登记在 canonical 货场群粒度、含货类与方向）只在同时满足
//   1) 存在当月货类兼容、换装成立、且各边实际开行并接受申报的候选路径；
//   2) 存在当月回单证据表明申报被受理且接续成功（直达视同接续成功）
// 时计作可达。多条候选不重复计权：判定单位是 OD 本身。
//
// 状态区分：
//   reachable        有路径且有正向证据
//   not_accepting    有工程/开行但不受理（或证据为不受理、接续失败）
//   no_service       当期无任何兼容候选路径（工程未恢复/回程不装等）
//   pending_evidence 有候选路径，但回单未报或仍待核——资料等待中，不得按零也不得按可达
import { expandGroup } from './frames.js'
import { findJourneys, normalizeObservations } from './network.js'

export const STATUS = {
  REACHABLE: 'reachable',
  NOT_ACCEPTING: 'not_accepting',
  NO_SERVICE: 'no_service',
  PENDING: 'pending_evidence',
}

// 正向证据：受理且（直达或接续成功）；最终交付作为观察依据的一部分记录。
function positiveEvidence(obs) {
  if (!obs) return null
  const accepted = obs.request === '受理'
  const connected = obs.connection === '直达' || obs.connection === '接续成功'
  return { accepted, connected, delivered: obs.delivery === '已交付', obs }
}

function negativeEvidence(obs) {
  if (!obs) return null
  const rejected = obs.request === '不受理'
  const failedConnection = obs.connection === '接续失败'
  const notDelivered = obs.delivery === '未交付'
  return { rejected, failedConnection, notDelivered, obs }
}

// 评估单个期别的单个 OD 关系
export function evaluateOd(ctx, odRow) {
  const { period, frameIndex, version, network, observations } = ctx
  const origins = expandGroup(frameIndex, version, odRow.origin).map((s) => s.station)
  const destinations = expandGroup(frameIndex, version, odRow.destination).map((s) => s.station)

  const journeys = findJourneys(network, period, origins, destinations, odRow.cargo)
  const obsKey = `${period}|${odRow.od}|${odRow.cargo}`
  const obs = observations.latest.get(obsKey) ?? null
  const evidenceHistory = observations.history.get(obsKey) ?? []

  const positive = positiveEvidence(obs)
  const negative = negativeEvidence(obs)
  const unreported =
    obs === null || (obs.request === '未报' && obs.connection === '未报' && obs.delivery === '未报')
  const awaitingVerification =
    obs !== null && (obs.connection === '待核' || obs.delivery === '待核')

  let status
  let reason
  if (journeys.length > 0 && positive && positive.accepted && positive.connected) {
    status = STATUS.REACHABLE
    reason = 'journey_and_positive_evidence'
  } else if (unreported) {
    // 无报送记录：无论工程是否恢复，都属资料等待，绝不按零也不按可达
    status = STATUS.PENDING
    reason = 'awaiting_report'
  } else if (awaitingVerification) {
    status = STATUS.PENDING
    reason = 'awaiting_verification'
  } else if (journeys.length === 0) {
    // 有明确观察但无兼容候选路径：
    // 发站方向实际开行了同货类班线却不受理 -> not_accepting（工程恢复但不收货）
    // 否则该方向当期无服务 -> no_service（回程不装/未恢复等）
    if (hasOutboundRunEdge(ctx, origins, odRow.cargo)) {
      status = STATUS.NOT_ACCEPTING
      reason = 'runs_but_not_accepting'
    } else {
      status = STATUS.NO_SERVICE
      reason = 'no_compatible_service'
    }
  } else if (negative && (negative.rejected || negative.failedConnection)) {
    status = STATUS.NOT_ACCEPTING
    reason = negative.rejected ? 'evidence_rejected_request' : 'evidence_failed_connection'
  } else {
    status = STATUS.PENDING
    reason = 'inconclusive_evidence'
  }

  return {
    period,
    od: odRow.od,
    origin: odRow.origin,
    destination: odRow.destination,
    cargo: odRow.cargo,
    framework: version,
    weight: odRow.weight,
    status,
    reason,
    journeys,
    observation: obs
      ? {
          observation: obs.observation,
          routes: obs.routes,
          request: obs.request,
          connection: obs.connection,
          delivery: obs.delivery,
          reportedAt: obs.reportedAt,
        }
      : null,
    evidenceHistory: evidenceHistory.map((row) => ({
      observation: row.observation,
      request: row.request,
      connection: row.connection,
      delivery: row.delivery,
      reportedAt: row.reported_at,
    })),
  }
}

// 发站群方向是否存在同货类、实际开行的班线（无论是否受理）。
// 用于把“工程恢复但不收货”与“当期无该方向服务”区分开。
function hasOutboundRunEdge(ctx, originStations, cargo) {
  const edges = ctx.network.edgesByPeriod.get(ctx.period)
  if (!edges) return false
  const originSet = new Set(originStations)
  for (const edge of edges.values()) {
    if (edge.cargo === cargo && edge.run === 'yes' && originSet.has(edge.from)) return true
  }
  return false
}

// 顶层构建：返回每期评估上下文，供指数、发布、追溯模块复用。
import { buildFrameIndex, periodVersionMap } from './frames.js'
import { buildNetwork } from './network.js'

export function buildEvaluation(tables) {
  const frames = tables.get('frames')
  const schedules = tables.get('schedules')
  const pvm = periodVersionMap(frames, schedules)
  const frameIndex = buildFrameIndex(frames)
  const network = buildNetwork(tables.get('schedules'), tables.get('transfers'))
  const observations = normalizeObservations(tables.get('journey_observations'))

  const periods = [...new Set(schedules.map((row) => row.period))].sort()
  const byPeriod = new Map()
  for (const period of periods) {
    const version = pvm.get(period)
    byPeriod.set(period, {
      period,
      version,
      frameIndex,
      network,
      observations,
      evaluate: (odRows) => {
        const ctx = { period, frameIndex, version, network, observations }
        return odRows.map((row) => evaluateOd(ctx, row))
      },
    })
  }
  return { periods, periodVersion: pvm, frameIndex, network, observations, byPeriod }
}
