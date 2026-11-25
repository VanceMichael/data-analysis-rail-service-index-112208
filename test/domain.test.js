import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadTables, checkRawShape } from '../src/io.js'
import { buildFromTables } from '../src/pipeline.js'
import { STATUS } from '../src/reachability.js'
import { traceOdByKey, traceStationByName, traceReportByName } from '../src/pipeline.js'
import { checkReferences } from '../src/cli.js'

const tables = await loadTables('../data')
const result = buildFromTables(tables)
const round = (value) => Math.round(value * 10000) / 10000

test('资料原始形状与跨表引用一致', () => {
  assert.deepEqual(checkRawShape(tables), [])
  assert.deepEqual(checkReferences(tables), [])
})

test('期别与站场框架版本按序对位（P0=V1, P1=V2）', () => {
  assert.deepEqual(result.periodVersion, { P0: 'V1', P1: 'V2' })
})

// ---- 可达性判定 ----
test('P0：有兼容路径与正向回单的关系计可达，缺报关系挂起不按零', () => {
  const p0 = new Map(result.monthly.P0.evaluations.map((row) => [row.od, row]))
  assert.equal(p0.get('O1').status, STATUS.REACHABLE)
  assert.equal(p0.get('O2').status, STATUS.REACHABLE)
  assert.equal(p0.get('O3').status, STATUS.PENDING)
  assert.equal(p0.get('O4').status, STATUS.PENDING)
})

test('P1：换装更正后 O1 恢复；O2 有开行但不受理；O3 真实改善；O4 等待资料', () => {
  const p1 = new Map(result.monthly.P1.evaluations.map((row) => [row.od, row]))
  assert.equal(p1.get('O1').status, STATUS.REACHABLE)
  // 更正记录 P1-30 等待 3 分钟，T4 到 19、T5 发 22，间隔 3 满足
  assert.deepEqual(p1.get('O1').journeys.map((j) => j.routes.join('+')), ['T4+T5'])
  assert.equal(p1.get('O2').status, STATUS.NOT_ACCEPTING)
  assert.equal(p1.get('O3').status, STATUS.REACHABLE)
  assert.equal(p1.get('O4').status, STATUS.PENDING)
  assert.equal(p1.get('O4').reason, 'awaiting_report')
})

test('一个 OD 不因多条候选路径重复计权', () => {
  const o1 = result.monthly.P1.evaluations.find((row) => row.od === 'O1')
  // 即使存在多条路径，状态与权重都只在 OD 粒度出现一次
  const occurrences = result.monthly.P1.evaluations.filter((row) => row.od === 'O1')
  assert.equal(occurrences.length, 1)
  assert.ok(o1.journeys.length >= 1)
})

// ---- 指数口径 ----
test('合同指数使用冻结基期权重，P0=0.65，P1=0.35', () => {
  assert.equal(result.monthly.P0.contractBasket.totalWeight, 100)
  assert.equal(result.monthly.P0.contractBasket.reachableWeight, 65)
  assert.equal(result.monthly.P0.contractBasket.index, 0.65)
  assert.equal(result.monthly.P1.contractBasket.reachableWeight, 35)
  assert.equal(result.monthly.P1.contractBasket.index, 0.35)
})

test('缺报关系不按零：另出可识别范围指数与覆盖度', () => {
  const p0 = result.monthly.P0.contractBasket
  assert.equal(p0.pendingWeight, 35)
  assert.equal(p0.identifiableWeight, 65)
  assert.equal(p0.observedScopeIndex, 1)
  assert.equal(p0.observedCoverage, 0.65)
  const p1 = result.monthly.P1.contractBasket
  assert.equal(p1.observedScopeIndex, round(35 / 75))
})

test('级别受指数阈值与发站群数双重约束', () => {
  // 基期篮发站群 H1,H2,H3 共 3 个，满足 min_group；P0 0.65 -> 乙（站点级）
  assert.equal(result.monthly.P0.grade.grade, '乙')
  assert.equal(result.monthly.P0.grade.detailed, '站点级')
  // P1 0.35 低于 0.6，不定级，只能给合计
  assert.equal(result.monthly.P1.grade.grade, null)
  assert.equal(result.monthly.P1.grade.detailed, null)
})

test('当期框架指数与真正新增服务范围分开报告', () => {
  // N1 H2->H4 散货是基期篮之外的新增关系
  const newService = result.monthly.P1.newServices.find((row) => row.od === 'N1')
  assert.ok(newService)
  assert.equal(newService.status, STATUS.REACHABLE)
  assert.deepEqual(newService.routes, ['T8'])
  // 新增范围进入当期框架指数，但不回写冻结基期合同指数
  assert.equal(result.monthly.P1.currentFrame.index, 0.65)
  assert.equal(result.monthly.P1.currentFrame.totalWeight, 100)
})

// ---- 共同范围比较与归因 ----
test('比较仅基于共同且两期均可识别的关系，缺报先给可识别范围', () => {
  const [cmp] = result.comparisons
  assert.equal(cmp.from, 'P0')
  assert.equal(cmp.to, 'P1')
  const keys = cmp.comparison.comparableRelations.map((row) => row.od).sort()
  assert.deepEqual(keys, ['O1', 'O2'])
  const excluded = cmp.comparison.excluded.map((row) => row.od).sort()
  assert.deepEqual(excluded, ['O3', 'O4'])
  assert.equal(cmp.comparison.commonWeight, 65)
  assert.equal(cmp.comparison.prevIndexOnCommon, 1)
  assert.equal(cmp.comparison.currIndexOnCommon, round(25 / 65))
})

test('指数下降归因为真实服务损失，覆盖扩大不归作基期改善', () => {
  const [cmp] = result.comparisons
  assert.equal(cmp.decomposition.indexDelta, -0.3)
  const loss = cmp.decomposition.serviceDrivers.filter((d) => d.kind === 'service_loss')
  assert.deepEqual(loss.map((d) => d.od), ['O2'])
  const coverageOds = cmp.decomposition.coverageChanges.map((d) => d.od).sort()
  assert.ok(coverageOds.includes('N1'))
  assert.ok(coverageOds.includes('O3'))
})

// ---- 发布、权限、修订 ----
test('合作方仅收到自身货类/区域范围的小计，不含全局指标', () => {
  const p1 = result.releases.P1
  const r1 = p1.manifests.R1 // W：西区木材
  const r2 = p1.manifests.R2 // N：北区受限散货
  assert.ok(!('globalTotal' in r1))
  assert.ok(!('globalTotal' in r2))
  for (const relation of r1.relations) {
    assert.equal(relation.cargo, '木材')
  }
  for (const relation of r2.relations) {
    assert.equal(relation.cargo, '散货')
  }
  // N 的北区散货：N1 可达、O4 在其权限内但处于资料等待（不得报成可达）
  assert.deepEqual(
    r2.relations.map((row) => row.od).sort(),
    ['N1', 'O4'],
  )
  assert.equal(r2.relations.find((row) => row.od === 'N1').status, STATUS.REACHABLE)
  assert.equal(r2.relations.find((row) => row.od === 'O4').status, STATUS.PENDING)
  assert.ok(r1.relations.map((row) => row.od).includes('O3'))
})

test('P1 未定级，所有分表与总表均仅出合计，不附路线/站点明细', () => {
  for (const manifest of Object.values(result.releases.P1.manifests)) {
    assert.equal(manifest.detailLevel, 'aggregate_only')
    for (const relation of manifest.relations) {
      assert.equal(relation.routes, undefined)
      assert.equal(relation.originStations, undefined)
    }
  }
})

test('P0 定为乙级，公开总表可附站点级但不含开行路线', () => {
  const r0 = result.releases.P0.manifests.R0
  assert.equal(r0.detailLevel, 'station')
  assert.ok(r0.relations.every((row) => Array.isArray(row.originStations)))
  assert.ok(r0.relations.every((row) => row.routes === undefined))
})

test('已送 R2 遇晚到换装更正保留原版；未送 R1/R3 按当前范围重出', () => {
  const plans = new Map(result.releases.P1.plans.map((plan) => [plan.report, plan]))
  assert.equal(plans.get('R2').action, 'retain_original')
  assert.ok(plans.get('R2').revisionReason.includes('原版留存'))
  assert.equal(plans.get('R1').action, 'reissue_current_scope')
  assert.equal(plans.get('R1').revision, '2')
  assert.equal(plans.get('R3').action, 'reissue_current_scope')
  assert.equal(plans.get('R3').revision, '2')
})

test('反推断检查通过且总表与分表可对账', () => {
  const p1 = result.releases.P1
  assert.ok(p1.antiInference.every((check) => check.ok))
  assert.equal(p1.reconciliation.ok, true)
  assert.equal(p1.reconciliation.publicReachableWeight, 65)
  // 合作方可见并集：W 的 O3（当期权重11）+ N 的 N1（权重27）= 38，不超总表
  assert.equal(p1.reconciliation.partnerReachableWeightUnion, 38)
  assert.ok(p1.reconciliation.partnerReachableWeightUnion <= 65)
  // 分表并集 + 未向任何合作方披露的关系，应与总表可达权重闭合
  const disclosedOds = new Set()
  for (const manifest of [p1.manifests.R1, p1.manifests.R2]) {
    for (const relation of manifest.relations) disclosedOds.add(relation.od)
  }
  const undisclosedReachable = p1.manifests.R3.relations
    .filter((row) => row.status === STATUS.REACHABLE && !disclosedOds.has(row.od))
    .reduce((sum, row) => sum + row.weight, 0)
  assert.equal(
    p1.reconciliation.partnerReachableWeightUnion + undisclosedReachable,
    p1.reconciliation.publicReachableWeight,
  )
})

// ---- 追溯 ----
test('从下降指数可回查 O2 的业务断点（不受理）与 O4 的资料等待', () => {
  const o2 = traceOdByKey(result, 'P1', 'O2')
  assert.equal(o2.status, STATUS.NOT_ACCEPTING)
  assert.ok(o2.blockers.some((b) => b.kind === 'acceptance'))
  const o4 = traceOdByKey(result, 'P1', 'O4')
  assert.equal(o4.status, STATUS.PENDING)
  assert.ok(o4.blockers.some((b) => b.kind === 'awaiting_data'))
})

test('回单后续更新覆盖先前观察，历史保留可追溯（O1 待核->接续成功）', () => {
  const o1 = traceOdByKey(result, 'P1', 'O1')
  assert.equal(o1.latestEvidence.observation, 'J16')
  assert.equal(o1.latestEvidence.connection, '接续成功')
  assert.deepEqual(o1.evidenceHistory.map((row) => row.observation), ['J11', 'J16'])
  assert.ok(o1.transferRevisions.some((row) => row.state === '已更正'))
})

test('站场追溯：S2a 沿革、班线、换装更正与所属报表/发出证据串联', () => {
  const station = traceStationByName(result, 'S2a')
  assert.deepEqual(station.canonicalGroups, ['H2'])
  assert.ok(station.groupHistory[0].timeline.some((row) => row.version === 'V1' && row.station === 'S2'))
  assert.ok(station.relatedRoutes.some((row) => row.route === 'T6'))
  assert.ok(station.relatedTransfers.some((row) => row.state === '已更正'))
  assert.ok(station.reportLinks.some((link) => link.report === 'R1'))
})

test('报表追溯：R2 收悉后更正标记为保留原版，R1 未送达标记重出', () => {
  const r2 = traceReportByName(result, 'R2')
  assert.equal(r2.disposition, 'retain_original_with_revision_note')
  assert.ok(r2.correctionsAfterReceipt.some((row) => (row.reportedAt ?? row.reported_at) === 'P1-30'))
  const r1 = traceReportByName(result, 'R1')
  assert.equal(r1.disposition, 'not_delivered_reissue_before_send')
})
