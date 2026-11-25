// 端到端编排：读取资料 -> 可达性评估 -> 指数/级别 -> 共同范围比较与归因
// -> 权限发布清单与修订安排 -> 对账/反推断 -> 追溯入口。
// 全部按期别数据驱动，新增一期资料只需在 data/ 落表后重跑。
import { loadTables } from './io.js'
import { buildEvaluation, STATUS } from './reachability.js'
import { comparePeriods, decomposeChange, monthlyIndex, relKey } from './index.js'
import {
  antiInferenceCheck,
  buildManifest,
  parsePermission,
  planRelease,
  reconcile,
} from './publish.js'
import { explainIndexDrop, traceOd, traceReport, traceStation } from './trace.js'

export async function runPipeline(dataDir) {
  const tables = await loadTables(dataDir)
  return buildFromTables(tables)
}

export function buildFromTables(tables) {
  const evaluation = buildEvaluation(tables)
  const baselineRows = tables.get('baseline')
  const currentFrameRows = tables.get('current_frame')
  const policy = tables.get('index_policy').sort(
    (a, b) => Number(b.min_index) - Number(a.min_index),
  )

  const periods = evaluation.periods
  const monthly = new Map()
  for (const period of periods) {
    const ctx = evaluation.byPeriod.get(period)
    // 合同口径：冻结基期篮，逐期用当期网络与回单重新判定
    const baselineEvaluations = ctx.evaluate(baselineRows)
    // 当期框架：含新增起讫，权重与篮子来自当期资料
    const currentEvaluations = ctx.evaluate(currentFrameRows)
    monthly.set(
      period,
      monthlyIndex(
        period,
        baselineRows,
        baselineEvaluations,
        currentEvaluations,
        policy,
      ),
    )
  }

  // 相邻期比较（数据驱动，不写死 P0/P1）
  // 两期都在同一冻结基期篮上评估，保证比较的是共同起讫关系；
  // 当期框架新增关系（如 N1）经 currentOnly 进入覆盖变化，而非混进合同指数。
  const comparisons = []
  for (let i = 1; i < periods.length; i += 1) {
    const prev = monthly.get(periods[i - 1])
    const curr = monthly.get(periods[i])
    const comparison = comparePeriods(
      prev.evaluations,
      curr.evaluations,
      curr.currentEvaluations,
    )
    const decomposition = decomposeChange(prev, curr, comparison)
    comparisons.push({
      from: periods[i - 1],
      to: periods[i],
      comparison,
      decomposition,
      dropExplanation: explainIndexDrop(prev, curr, comparison, decomposition),
    })
  }

  // 发布安排按期生成（reporting 表自带 period）
  const releases = new Map()
  for (const period of periods) {
    const ctx = evaluation.byPeriod.get(period)
    const index = monthly.get(period)
    const periodReports = tables.get('reporting').filter((row) => row.period === period)
    const periodTransfers = tables.get('transfers').filter((row) => row.period === period)
    const correctionCutoff = periodTransfers
      .map((row) => row.reported_at)
      .sort()
      .at(-1) ?? null

    const manifests = new Map()
    for (const reportRow of periodReports) {
      const manifest = buildManifest({
        reportRow,
        period,
        version: ctx.version,
        frameIndex: evaluation.frameIndex,
        // 公开总表用当期框架评估（含新服务）；受限/区域分表同样基于当期评估，
        // 合同指数同时保留在 monthly 中，分表合计是其权限范围内的小计
        evaluations: index.currentEvaluations,
        policy,
        // 明细门控按合同篮子的整期全局级别，合作方仅在该级别下看自身权限范围
        globalGrade: index.grade,
        transferRevisions: periodTransfers,
      })
      manifests.set(reportRow.report, manifest)
    }

    const receipts = tables.get('report_receipts')
    const plans = planRelease({
      reporting: periodReports,
      receipts,
      manifests,
      correctionCutoff,
    })

    // 公开总表与合作方分表对账
    const publicReport = periodReports.find((row) => parsePermission(row).public)
    const publicManifest = publicReport ? manifests.get(publicReport.report) : null
    const partnerManifests = periodReports
      .filter((row) => !parsePermission(row).public)
      .map((row) => manifests.get(row.report))
    const reconciliation = publicManifest
      ? reconcile(publicManifest, partnerManifests)
      : null

    // 反推断逐合作方检查
    const checks = periodReports
      .filter((row) => !parsePermission(row).public)
      .map((row) => ({
        report: row.report,
        ...antiInferenceCheck(
          manifests.get(row.report),
          parsePermission(row),
          evaluation.frameIndex,
          ctx.version,
          index.currentEvaluations,
        ),
      }))

    releases.set(period, {
      period,
      correctionCutoff,
      manifests: Object.fromEntries(manifests),
      plans,
      reconciliation,
      antiInference: checks,
    })
  }

  return {
    periods,
    periodVersion: Object.fromEntries(evaluation.periodVersion),
    monthly: Object.fromEntries(monthly),
    comparisons,
    releases: Object.fromEntries(releases),
    tables,
    evaluation,
  }
}

// ---- 追溯入口（CLI 与测试共用）----
export function traceOdByKey(result, period, od) {
  const index = result.monthly[period]
  const baselineEval = index.evaluations.find((row) => row.od === od)
  const currentEval =
    index.currentEvaluations.find((row) => row.od === od) ?? baselineEval
  const evaluation = currentEval ?? baselineEval
  const baselineRow = result.tables.get('baseline').find((row) => row.od === od) ?? null
  const currentRow = result.tables.get('current_frame').find((row) => row.od === od) ?? null
  const transferHistory = result.tables
    .get('transfers')
    .filter((row) => row.period === period)
    .filter((row) => {
      const routeSet = new Set(evaluation.journeys.flatMap((journey) => journey.routes))
      return routeSet.has(row.from_route) || routeSet.has(row.to_route)
    })
  return traceOd({
    od,
    period,
    evaluation,
    baselineRow,
    currentRow,
    transferHistory,
    receiptsForOd: [],
  })
}

export function traceStationByName(result, station) {
  return traceStation({
    station,
    frames: result.tables.get('frames'),
    schedules: result.tables.get('schedules'),
    transfers: result.tables.get('transfers'),
    reporting: result.tables.get('reporting'),
    receipts: result.tables.get('report_receipts'),
    versionByPeriod: result.evaluation.periodVersion,
  })
}

export function traceReportByName(result, report) {
  const reportRow = result.tables.get('reporting').find((row) => row.report === report)
  const periodTransfers = result.tables
    .get('transfers')
    .filter((row) => row.period === reportRow.period)
  return traceReport({
    reportRow,
    receipts: result.tables.get('report_receipts'),
    transferRevisions: periodTransfers,
  })
}

export { STATUS, relKey }
