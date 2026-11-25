// 运行图网络：把班次级开行记录组织成有向边，并在兼容换装的前提下
// 枚举一个期别内可用的接续路径。返回方向（回程）各自独立登记。
import { num, parseMissing, parseStamp, splitIds } from './io.js'

export function buildNetwork(schedules, transfers) {
  const edgesByPeriod = new Map()
  for (const row of schedules) {
    if (!edgesByPeriod.has(row.period)) edgesByPeriod.set(row.period, new Map())
    edgesByPeriod.get(row.period).set(row.route, {
      route: row.route,
      period: row.period,
      from: row.from_station,
      to: row.to_station,
      cargo: row.cargo,
      depart: num(row.depart),
      arrive: num(row.arrive),
      // 实际开行且本期接受申报，才是可装载的边
      accept: row.accept,
      run: row.run,
    })
  }

  // 换装报送：同 (期,站,前序线,后续线,货类) 可能多次报送，取时点最新一条。
  const transferByKey = new Map()
  const transferHistory = new Map()
  for (const row of transfers) {
    const key = transferKey(row)
    if (!transferHistory.has(key)) transferHistory.set(key, [])
    transferHistory.get(key).push(row)
    const prev = transferByKey.get(key)
    if (!prev || parseStamp(row.reported_at).seq >= parseStamp(prev.reported_at).seq) {
      transferByKey.set(key, row)
    }
  }
  return { edgesByPeriod, transferByKey, transferHistory }
}

export function transferKey(row) {
  return `${row.period}|${row.station}|${row.from_route}->${row.to_route}|${row.cargo}`
}

export function edgeUsable(edge, cargo) {
  return (
    edge !== undefined &&
    edge.cargo === cargo &&
    edge.run === 'yes' &&
    edge.accept === 'yes'
  )
}

// 一次换装是否成立：货类兼容、状态认可，且到达后等待达到最短间隔。
// state:
//   有效   -> 可用（仍核对等待时间）
//   已更正 -> 可用，代表对早前报送的更正（仍核对等待时间）
//   不足   -> 明确不满足，不可用
// 未报（"?"）的字段一律按未知处理，不臆造为可用。
export function transferWorks(transfer, incomingEdge, outgoingEdge) {
  if (!transfer) return { works: false, reason: 'no_transfer_report' }
  if (transfer.state === '不足') return { works: false, reason: 'insufficient_wait_state' }
  if (transfer.state !== '有效' && transfer.state !== '已更正') {
    return { works: false, reason: `unrecognized_state:${transfer.state}` }
  }
  const wait = num(transfer.min_wait)
  if (wait === null) return { works: false, reason: 'min_wait_missing' }
  // 时刻为当地分钟；到达后到发车间的实际间隔。允许跨日场景由资料直接给分钟差值，
  // 这里按出发不早于到达 + 最短间隔判定。
  if (incomingEdge.arrive + wait > outgoingEdge.depart) {
    return { works: false, reason: 'wait_below_minimum' }
  }
  return { works: true, reason: null, wait, state: transfer.state, reportedAt: transfer.reported_at }
}

// 枚举从 origin 各分站到 destination 各分站、满足货类与换装约束的路径。
// 一条路径是一组班线（route id），顺序即经由。
export function findJourneys(network, period, originStations, destinationStations, cargo) {
  const edges = network.edgesByPeriod.get(period)
  if (!edges) return []
  const originSet = new Set(originStations)
  const destSet = new Set(destinationStations)
  const results = []
  const MAX_DEPTH = 6

  // 深度优先沿可用边推进；在每个中转点用换装表决定能否接续。
  const walk = (station, path, edgePath, visitedEdges) => {
    if (destSet.has(station) && edgePath.length > 0) {
      results.push({ routes: [...edgePath], stations: [...path], cargo })
    }
    if (edgePath.length >= MAX_DEPTH) return
    for (const edge of edges.values()) {
      if (edge.from !== station) continue
      if (!edgeUsable(edge, cargo)) continue
      if (visitedEdges.has(edge.route)) continue
      if (edgePath.length === 0) {
        if (!originSet.has(edge.from)) continue
        walk(edge.to, [...path, edge.to], [...edgePath, edge.route], new Set([...visitedEdges, edge.route]))
        continue
      }
      const incoming = edges.get(edgePath[edgePath.length - 1])
      const transfer = network.transferByKey.get(
        `${period}|${station}|${incoming.route}->${edge.route}|${cargo}`,
      )
      const check = transferWorks(transfer, incoming, edge)
      if (!check.works) continue
      walk(edge.to, [...path, edge.to], [...edgePath, edge.route], new Set([...visitedEdges, edge.route]))
    }
  }

  for (const start of originStations) walk(start, [start], [], new Set())
  // 去重：同一组班线顺序一致只保留一条
  const seen = new Set()
  return results.filter((journey) => {
    const sig = journey.routes.join('+')
    if (seen.has(sig)) return false
    seen.add(sig)
    return true
  })
}

// 回单观察的标准化。同一 (期,od,货类) 后续回单可更新先前观察，
// 以 reported_at 最新者为准，历史保留用于追溯。
export function normalizeObservations(observations) {
  const byKey = new Map()
  const history = new Map()
  for (const row of observations) {
    const key = `${row.period}|${row.od}|${row.cargo}`
    if (!history.has(key)) history.set(key, [])
    history.get(key).push(row)
    const current = byKey.get(key)
    if (!current || parseStamp(row.reported_at).seq >= parseStamp(current.reportedAt).seq) {
      byKey.set(key, {
        observation: row.observation,
        period: row.period,
        od: row.od,
        cargo: row.cargo,
        routes: splitIds(row.routes),
        routesRaw: parseMissing(row.routes),
        request: row.request,
        connection: row.connection,
        delivery: row.delivery,
        reportedAt: row.reported_at,
      })
    }
  }
  for (const list of history.values()) {
    list.sort((a, b) => parseStamp(a.reported_at).seq - parseStamp(b.reported_at).seq)
  }
  return { latest: byKey, history }
}
