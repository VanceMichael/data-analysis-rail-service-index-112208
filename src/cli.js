#!/usr/bin/env node
// 分析员命令行入口（Node.js 22，无第三方依赖）。
//
//   node src/cli.js check                         校验资料结构与引用
//   node src/cli.js index [--period P1]           月度指数与级别
//   node src/cli.js compare                       相邻期共同范围比较与归因
//   node src/cli.js release [--period P1]         发布清单、修订安排、对账与反推断
//   node src/cli.js trace --od O2 --period P1     从指数回查单个起讫关系
//   node src/cli.js trace --station S2a           从站场走到报表与发出证据
//   node src/cli.js trace --report R2             报表收悉与更正处置
//   node src/cli.js build [--out out]             生成全套 JSON 产物
import { mkdir, writeFile } from 'node:fs/promises'
import { checkRawShape, TABLE_NAMES } from './io.js'
import {
  buildFromTables,
  runPipeline,
  traceOdByKey,
  traceReportByName,
  traceStationByName,
} from './pipeline.js'
import { loadTables } from './io.js'

function parseArgs(argv) {
  const args = { _: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token.startsWith('--')) {
      const key = token.slice(2)
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) {
        args[key] = true
      } else {
        args[key] = next
        i += 1
      }
    } else {
      args._.push(token)
    }
  }
  return args
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const command = args._[0] ?? 'build'
  const dataDir = args.data ?? '../data'

  const print = (value) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)

  switch (command) {
    case 'check': {
      const tables = await loadTables(dataDir)
      const problems = checkRawShape(tables)
      const references = checkReferences(tables)
      print({ tables: TABLE_NAMES, shapeProblems: problems, referenceProblems: references })
      if (problems.length || references.length) process.exitCode = 1
      return
    }
    case 'index': {
      const result = await runPipeline(dataDir)
      if (args.period) {
        print(result.monthly[args.period])
      } else {
        print(Object.fromEntries(
          Object.entries(result.monthly).map(([period, index]) => [period, compactIndex(index)]),
        ))
      }
      return
    }
    case 'compare': {
      const result = await runPipeline(dataDir)
      print(result.comparisons)
      return
    }
    case 'release': {
      const result = await runPipeline(dataDir)
      if (args.period) {
        print(result.releases[args.period])
      } else {
        print(result.releases)
      }
      return
    }
    case 'trace': {
      const result = await runPipeline(dataDir)
      if (args.od) {
        print(traceOdByKey(result, args.period ?? result.periods.at(-1), args.od))
      } else if (args.station) {
        print(traceStationByName(result, args.station))
      } else if (args.report) {
        print(traceReportByName(result, args.report))
      } else {
        throw new Error('trace 需要 --od、--station 或 --report')
      }
      return
    }
    case 'build': {
      const outDir = args.out ?? '../out'
      const result = await runPipeline(dataDir)
      await writeOutputs(outDir, result)
      print({ written: outDir, periods: result.periods })
      return
    }
    default:
      throw new Error(`未知命令: ${command}`)
  }
}

function compactIndex(index) {
  return {
    period: index.period,
    contractBasket: index.contractBasket,
    currentFrame: index.currentFrame,
    grade: index.grade,
    newServices: index.newServices,
  }
}

async function writeOutputs(outDir, result) {
  await mkdir(new URL(outDir, import.meta.url), { recursive: true })
  const target = (name) => new URL(`${outDir}/${name}`, import.meta.url)
  await writeFile(target('monthly-index.json'), JSON.stringify(result.monthly, null, 2))
  await writeFile(target('comparisons.json'), JSON.stringify(result.comparisons, null, 2))
  await writeFile(target('releases.json'), JSON.stringify(result.releases, null, 2))
  const traces = {
    ods: Object.fromEntries(
      result.periods.flatMap((period) =>
        Object.keys(result.monthly[period].currentEvaluations.reduce((map, row) => {
          map[row.od] = true
          return map
        }, {})).map((od) => [
          `${period}:${od}`,
          traceOdByKey(result, period, od),
        ]),
      ),
    ),
    stations: [...new Set(result.tables.get('frames').map((row) => row.station))].map((station) =>
      traceStationByName(result, station),
    ),
    reports: result.tables.get('reporting').map((row) => traceReportByName(result, row.report)),
  }
  await writeFile(target('traces.json'), JSON.stringify(traces, null, 2))
}

// 引用一致性检查：运行图分站须属于期别框架；换装/回单引用的班线与 OD 须存在。
export function checkReferences(tables) {
  const problems = []
  const frames = tables.get('frames')
  const schedules = tables.get('schedules')
  const versionByPeriod = new Map()
  {
    const periods = [...new Set(schedules.map((row) => row.period))].sort()
    const versions = [...new Set(frames.map((row) => row.version))].sort()
    periods.forEach((period, i) => versionByPeriod.set(period, versions[i]))
  }
  const stationVersion = new Set(frames.map((row) => `${row.station}/${row.version}`))
  const routeByPeriod = new Map()
  for (const row of schedules) {
    const version = versionByPeriod.get(row.period)
    for (const station of [row.from_station, row.to_station]) {
      if (!stationVersion.has(`${station}/${version}`)) {
        problems.push(`运行图 ${row.route} 引用了 ${version} 中不存在的分站 ${station}`)
      }
    }
    if (!routeByPeriod.has(row.period)) routeByPeriod.set(row.period, new Set())
    routeByPeriod.get(row.period).add(row.route)
  }
  for (const row of tables.get('transfers')) {
    const routes = routeByPeriod.get(row.period)
    for (const route of [row.from_route, row.to_route]) {
      if (!routes?.has(route)) problems.push(`换装记录引用未知班线 ${route}`)
    }
  }
  const knownOds = new Set([
    ...tables.get('baseline').map((row) => row.od),
    ...tables.get('current_frame').map((row) => row.od),
  ])
  for (const row of tables.get('journey_observations')) {
    if (!knownOds.has(row.od)) problems.push(`回单 ${row.observation} 引用未知 OD ${row.od}`)
    const routes = routeByPeriod.get(row.period)
    if (row.routes !== '?') {
      for (const route of row.routes.split('+')) {
        if (!routes?.has(route)) problems.push(`回单 ${row.observation} 引用未知班线 ${route}`)
      }
    }
  }
  return problems
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`)
  process.exit(1)
})
