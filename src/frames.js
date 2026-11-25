// 站场框架：分站、canonical 货场群、拆分份额、期别与框架版本的对应。
// 起讫关系登记在 canonical（H*）粒度；运行图登记在当期分站（S*）粒度。
import { num } from './io.js'

// 期别 -> 框架版本。按期别与版本各自排序后对位，
// 这样下一期（P2/V3...）资料到位后无需改代码。
export function periodVersionMap(frames, schedules) {
  const versions = [...new Set(frames.map((row) => row.version))].sort()
  const periods = [...new Set(schedules.map((row) => row.period))].sort()
  if (periods.length > versions.length) {
    throw new Error('运行图期别多于站场框架版本，无法对位')
  }
  return new Map(periods.map((period, i) => [period, versions[i]]))
}

export function buildFrameIndex(frames) {
  // version -> station -> 框架行
  const byVersion = new Map()
  for (const row of frames) {
    if (!byVersion.has(row.version)) byVersion.set(row.version, new Map())
    byVersion.get(row.version).set(row.station, row)
  }
  return byVersion
}

// 某版本下一个 canonical 货场群包含的分站（拆分后可能多个）
export function expandGroup(frameIndex, version, canonical) {
  const versionRows = frameIndex.get(version)
  if (!versionRows) return []
  return [...versionRows.values()]
    .filter((row) => row.canonical === canonical)
    .map((row) => ({
      station: row.station,
      canonical: row.canonical,
      regional: row.regional,
      share: num(row.share),
      frameCargo: row.cargo,
    }))
}

export function stationRow(frameIndex, version, station) {
  return frameIndex.get(version)?.get(station) ?? null
}

// 货场群沿革：每个 canonical 在各版本下由哪些分站承担、份额多少。
// 站场合并/更名前的分站权重按当时框架事实原样解释，不回改历史。
export function lineage(frames) {
  const map = new Map()
  for (const row of frames) {
    if (!map.has(row.canonical)) map.set(row.canonical, [])
    map.get(row.canonical).push({
      version: row.version,
      station: row.station,
      regional: row.regional,
      share: num(row.share),
      frameCargo: row.cargo,
    })
  }
  for (const entries of map.values()) {
    entries.sort((a, b) => a.version.localeCompare(b.version))
  }
  return map
}

// 两个框架版本之间共同的起讫关系：canonical 发站、到站、货类三者一致。
// 被拆开的货场只保留旧关系中当期仍有对应分站与货类观察的部分，
// 因此共同关系按 canonical 三元组识别，再由可达性层补证据校验。
export function commonRelations(leftRows, rightRows) {
  const key = (row) => `${row.origin}->${row.destination}|${row.cargo}`
  const rightKeys = new Map(rightRows.map((row) => [key(row), row]))
  const common = []
  const rightOnly = []
  for (const row of rightRows) {
    if (!leftRows.some((left) => key(left) === key(row))) rightOnly.push(row)
  }
  for (const left of leftRows) {
    const right = rightKeys.get(key(left))
    if (right) common.push({ baseline: left, current: right, key: key(left) })
  }
  return { common, rightOnly }
}
