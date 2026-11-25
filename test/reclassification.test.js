import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildFromTables } from '../src/pipeline.js'
import { parsePermission, antiInferenceCheck } from '../src/publish.js'

// 合成资料：构造一个指数达甲级（>=0.8、>=3 发站群）的期别，
// 验证细分线路重新归类只改变合作方收到的线路，不改变总指数与总级别。
function baseTables() {
  return {
    frames: [
      { station: 'S1', version: 'V1', canonical: 'H1', regional: '西', share: '1', cargo: '杂货' },
      { station: 'S2', version: 'V1', canonical: 'H2', regional: '西', share: '1', cargo: '杂货' },
      { station: 'S3', version: 'V1', canonical: 'H3', regional: '东', share: '1', cargo: '杂货' },
      { station: 'S4', version: 'V1', canonical: 'H4', regional: '北', share: '1', cargo: '杂货' },
    ],
    baseline: [
      { od: 'A', origin: 'H1', destination: 'H3', cargo: '杂货', weight: '40', framework: 'V1' },
      { od: 'B', origin: 'H2', destination: 'H3', cargo: '杂货', weight: '30', framework: 'V1' },
      { od: 'C', origin: 'H4', destination: 'H3', cargo: '杂货', weight: '30', framework: 'V1' },
    ],
    current_frame: [
      { period: 'Px', od: 'A', origin: 'H1', destination: 'H3', cargo: '杂货', weight: '40', framework: 'V1' },
      { period: 'Px', od: 'B', origin: 'H2', destination: 'H3', cargo: '杂货', weight: '30', framework: 'V1' },
      { period: 'Px', od: 'C', origin: 'H4', destination: 'H3', cargo: '杂货', weight: '30', framework: 'V1' },
    ],
    index_policy: [
      { grade: '甲', min_index: '0.8', detailed: '开行路线', min_group: '3' },
      { grade: '乙', min_index: '0.6', detailed: '站点级', min_group: '3' },
    ],
    reporting: [
      { report: 'PUB', period: 'Px', scope: '全区', recipient: '行业', permission: '公开', current: '1', state: '待发' },
      { report: 'WEST', period: 'Px', scope: '西区', recipient: 'W', permission: '西区杂货', current: '1', state: '待发' },
    ],
    report_receipts: [],
    transfers: [],
  }
}

function observationsFor(routesByOd) {
  return Object.entries(routesByOd).map(([od, routes], i) => ({
    observation: `K${i}`,
    period: 'Px',
    od,
    routes,
    cargo: '杂货',
    request: '受理',
    connection: routes.includes('+') ? '接续成功' : '直达',
    delivery: '已交付',
    reported_at: `Px-${10 + i}`,
  }))
}

// 场景一：B 关系由西线 TX 承担
function scenarioWest() {
  const tables = new Map(Object.entries(baseTables()))
  tables.set('schedules', [
    { period: 'Px', route: 'TA', from_station: 'S1', to_station: 'S3', cargo: '杂货', depart: '1', arrive: '2', accept: 'yes', run: 'yes' },
    { period: 'Px', route: 'TB', from_station: 'S2', to_station: 'S3', cargo: '杂货', depart: '3', arrive: '4', accept: 'yes', run: 'yes' },
    { period: 'Px', route: 'TC', from_station: 'S4', to_station: 'S3', cargo: '杂货', depart: '5', arrive: '6', accept: 'yes', run: 'yes' },
  ])
  tables.set('journey_observations', observationsFor({ A: 'TA', B: 'TB', C: 'TC' }))
  return tables
}

// 场景二：B 关系重新归类，改由新增的北线 TBN 承担（H2 在该合成框架仍属西，
// 这里通过把 S2 重新划到北区来模拟归属更正）。
function scenarioReclassified() {
  const tables = scenarioWest()
  const frames = tables.get('frames').map((row) =>
    row.station === 'S2' ? { ...row, regional: '北' } : row,
  )
  tables.set('frames', frames)
  return tables
}

test('细分线路重新归类：总指数与总级别保持不变，合作方线路归属改变', () => {
  const west = buildFromTables(scenarioWest())
  const moved = buildFromTables(scenarioReclassified())

  // 总指数（合同口径）与级别在两版下完全一致
  assert.equal(west.monthly.Px.contractBasket.index, 1)
  assert.equal(moved.monthly.Px.contractBasket.index, 1)
  assert.equal(west.monthly.Px.grade.grade, '甲')
  assert.equal(moved.monthly.Px.grade.grade, '甲')
  assert.equal(west.monthly.Px.grade.detailed, '开行路线')

  const westManifest = west.releases.Px.manifests.WEST
  const movedManifest = moved.releases.Px.manifests.WEST
  // 甲级才允许附带开行路线明细
  assert.equal(westManifest.detailLevel, 'route')

  const westOds = westManifest.relations.map((row) => row.od).sort()
  const movedOds = movedManifest.relations.map((row) => row.od).sort()
  assert.ok(westOds.includes('B'))
  assert.ok(!movedOds.includes('B')) // B 重新归到北区后，西区合作方不再收到

  // 公开总表两版都能看到全部关系，且总数一致
  assert.equal(west.releases.Px.manifests.PUB.relations.length, 3)
  assert.equal(moved.releases.Px.manifests.PUB.relations.length, 3)

  // 重新归类后对西区合作方仍通过反推断检查，不泄漏北区线路
  const permission = parsePermission(tables_reporting(moved).find((row) => row.report === 'WEST'))
  const check = antiInferenceCheck(
    movedManifest,
    permission,
    moved.evaluation.frameIndex,
    moved.periodVersion.Px,
    moved.monthly.Px.currentEvaluations,
  )
  assert.ok(check.ok)
})

function tables_reporting(result) {
  return result.tables.get('reporting')
}

test('回程不装与无报送分别落入不同状态，不混为可达', () => {
  const tables = scenarioWest()
  // 新增一个回程方向关系 D：当期无任何兼容班线
  tables.get('baseline').push({ od: 'D', origin: 'H3', destination: 'H1', cargo: '杂货', weight: '20', framework: 'V1' })
  tables.get('current_frame').push({ period: 'Px', od: 'D', origin: 'H3', destination: 'H1', cargo: '杂货', weight: '20', framework: 'V1' })
  const result = buildFromTables(tables)
  const d = result.monthly.Px.evaluations.find((row) => row.od === 'D')
  assert.equal(d.status, 'pending_evidence')
  assert.equal(d.reason, 'awaiting_report')
})
