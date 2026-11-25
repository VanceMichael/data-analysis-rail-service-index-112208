// 月度可达性指数与级别。
//
// 指数口径（合同口径）：
//   - 篮子与权重来自冻结基期 baseline（固定基期货类、发站群、起讫权重），当期不回改；
//   - 分子是当期判定为 reachable 的基期 OD 权重之和；
//   - 分母是基期权重总和（未报按“不可识别/不计分子”处理，绝不按零也不按可达）。
// 同时给：
//   - observedScopeIndex：仅在当期有可识别观察依据的基期权重范围内出报，供基期冷门线缺报时使用；
//   - currentFrameIndex：当期业务框架（含新起讫）下的指数，反映当期结构，不回写合同指数；
//   - 级别 grade 由 index_policy 决定，且要求发站群数达到 min_group；
//   - 新增服务范围 newServices：当期框架中基期篮子没有的起讫关系。
import { num } from './io.js'
import { STATUS } from './reachability.js'

function weighted(evaluations, predicate) {
  return evaluations
    .filter(predicate)
    .reduce((sum, row) => sum + num(row.weight), 0)
}

export function summarizeBasket(evaluations) {
  const totalWeight = weighted(evaluations, () => true)
  const reachableWeight = weighted(evaluations, (row) => row.status === STATUS.REACHABLE)
  const notAcceptingWeight = weighted(evaluations, (row) => row.status === STATUS.NOT_ACCEPTING)
  const noServiceWeight = weighted(evaluations, (row) => row.status === STATUS.NO_SERVICE)
  const pendingWeight = weighted(evaluations, (row) => row.status === STATUS.PENDING)

  // 可识别 = 有明确观察结论（可达或不可达），pending 属资料等待中
  const identifiable = evaluations.filter(
    (row) => row.status !== STATUS.PENDING,
  )
  const identifiableWeight = identifiable.reduce((sum, row) => sum + num(row.weight), 0)

  const originGroups = new Set(evaluations.map((row) => row.origin))

  return {
    totalWeight,
    reachableWeight,
    notAcceptingWeight,
    noServiceWeight,
    pendingWeight,
    identifiableWeight,
    originGroupCount: originGroups.size,
    relationCount: evaluations.length,
    index: totalWeight === 0 ? null : round4(reachableWeight / totalWeight),
    observedScopeIndex:
      identifiableWeight === 0 ? null : round4(reachableWeight / identifiableWeight),
    observedCoverage: totalWeight === 0 ? null : round4(identifiableWeight / totalWeight),
  }
}

export function gradeFor(indexValue, originGroupCount, policy) {
  // policy 已按 min_index 降序；满足阈值且发站群数达标才可定级
  for (const grade of policy) {
    if (
      indexValue !== null &&
      indexValue >= num(grade.min_index) &&
      originGroupCount >= num(grade.min_group)
    ) {
      return {
        grade: grade.grade,
        detailed: grade.detailed,
        minIndex: num(grade.min_index),
        minGroup: num(grade.min_group),
      }
    }
  }
  return { grade: null, detailed: null, reason: 'below_all_grades_or_too_few_groups' }
}

// 合同口径月度指数：冻结基期篮 + 当期评估
export function monthlyIndex(period, baselineRows, baselineEvaluations, currentEvaluations, policy) {
  const basket = summarizeBasket(baselineEvaluations)
  const currentBasket = summarizeBasket(currentEvaluations)

  const baselineKeys = new Set(baselineRows.map((row) => relKey(row)))
  const newServices = currentEvaluations
    .filter((row) => !baselineKeys.has(relKey(row)))
    .map((row) => ({
      od: row.od,
      origin: row.origin,
      destination: row.destination,
      cargo: row.cargo,
      weight: num(row.weight),
      status: row.status,
      routes: row.journeys.map((journey) => journey.routes.join('+')),
      note: '当期框架内、冻结基期篮之外的新增服务范围',
    }))

  const grade = gradeFor(basket.index, basket.originGroupCount, policy)

  return {
    period,
    contractBasket: {
      basis: 'frozen_baseline',
      ...basket,
    },
    currentFrame: {
      basis: 'current_frame',
      ...currentBasket,
    },
    grade,
    newServices,
    evaluations: baselineEvaluations,
    currentEvaluations,
  }
}

export function relKey(row) {
  return `${row.origin}->${row.destination}|${row.cargo}`
}

function round4(value) {
  return Math.round(value * 10000) / 10000
}

// 两期共同范围比较。
// 要求共同的起讫关系，并且两期都有成功接续/受理与货类观察依据（都可识别）。
// 基期冷门线缺报时，只就“能识别的范围”比较，并显式列出被排除的关系与原因。
export function comparePeriods(prevEvaluations, currEvaluations, extraCurrentEvaluations = []) {
  const prevMap = new Map(prevEvaluations.map((row) => [row.od, row]))
  const currMap = new Map(currEvaluations.map((row) => [row.od, row]))
  const comparable = []
  const excluded = []
  const currentOnly = []
  const baselineOnly = []

  // 当期框架相对冻结基期篮新增的起讫关系（不在合同篮子里，单列覆盖扩大）
  for (const curr of [...currEvaluations, ...extraCurrentEvaluations]) {
    if (!prevMap.has(curr.od)) {
      currentOnly.push({
        od: curr.od,
        cargo: curr.cargo,
        reason: 'not_in_baseline_basket',
        currStatus: curr.status,
      })
    }
  }
  // 基期有但当期框架消失的关系（保留口径，不静默丢弃）
  for (const prev of prevEvaluations) {
    if (!currMap.has(prev.od)) {
      baselineOnly.push({ od: prev.od, reason: 'missing_from_current_frame' })
    }
  }

  for (const curr of currEvaluations) {
    const prev = prevMap.get(curr.od)
    if (!prev) continue
    if (prev.status === STATUS.PENDING || curr.status === STATUS.PENDING) {
      excluded.push({
        od: curr.od,
        reason: 'missing_or_pending_observation',
        prevStatus: prev.status,
        currStatus: curr.status,
      })
      continue
    }
    comparable.push({
      od: curr.od,
      origin: curr.origin,
      destination: curr.destination,
      cargo: curr.cargo,
      weight: num(prevMap.get(curr.od).weight),
      prevStatus: prev.status,
      currStatus: curr.status,
      changed: prev.status !== curr.status,
      prevReachable: prev.status === STATUS.REACHABLE,
      currReachable: curr.status === STATUS.REACHABLE,
    })
  }

  const commonWeight = comparable.reduce((sum, item) => sum + item.weight, 0)
  const prevReachWeight = comparable
    .filter((item) => item.prevReachable)
    .reduce((sum, item) => sum + item.weight, 0)
  const currReachWeight = comparable
    .filter((item) => item.currReachable)
    .reduce((sum, item) => sum + item.weight, 0)

  return {
    comparableRelations: comparable,
    excluded,
    currentOnly,
    baselineOnly,
    commonWeight,
    prevIndexOnCommon: commonWeight === 0 ? null : round4(prevReachWeight / commonWeight),
    currIndexOnCommon: commonWeight === 0 ? null : round4(currReachWeight / commonWeight),
  }
}

// 把指数总变化分解为真实服务变化与口径/覆盖变化，
// 避免把“当前覆盖扩大”误报成“基期范围服务改善”。
export function decomposeChange(prevIndex, currIndex, comparison) {
  const drivers = comparison.comparableRelations
    .filter((item) => item.changed)
    .map((item) => {
      let kind
      if (item.prevReachable && !item.currReachable) kind = 'service_loss'
      else if (!item.prevReachable && item.currReachable) kind = 'service_gain'
      else kind = 'classification_change'
      return { od: item.od, cargo: item.cargo, kind, prevStatus: item.prevStatus, currStatus: item.currStatus }
    })

  const coverageChanges = [
    ...comparison.excluded.map((row) => ({ od: row.od, kind: 'observation_coverage', detail: row.reason })),
    ...comparison.currentOnly.map((row) => ({ od: row.od, kind: 'scope_expansion', detail: row.reason })),
  ]

  return {
    indexDelta: round4(currIndex.contractBasket.index - prevIndex.contractBasket.index),
    serviceDrivers: drivers,
    coverageChanges,
    note: 'serviceDrivers 为共同可识别范围内的真实可达性变化；coverageChanges 为口径/覆盖变化，不计作基期范围服务改善',
  }
}
