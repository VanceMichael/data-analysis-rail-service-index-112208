// 来源资料读取与原始值解析。
// 约定：资料中所有值均为字符串；"?" 表示来源未提供，绝不按零处理；
// 组合编号用 "+" 分隔；报送时点形如 "P1-30"。
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

export const MISSING = '?'

export const TABLE_NAMES = [
  'frames',
  'baseline',
  'schedules',
  'transfers',
  'reporting',
  'index_policy',
  'journey_observations',
  'current_frame',
  'report_receipts',
]

export async function loadTables(dir) {
  const tables = new Map()
  for (const name of TABLE_NAMES) {
    const file = new URL(join(dir, `${name}.json`), import.meta.url)
    const text = await readFile(file, 'utf8')
    tables.set(name, JSON.parse(text))
  }
  return tables
}

export async function listTableFiles(dir) {
  const files = await readdir(new URL(dir, import.meta.url))
  return files.filter((name) => name.endsWith('.json')).sort()
}

// "?" -> null，其余保留原始字符串
export function parseMissing(value) {
  return value === MISSING ? null : value
}

// "?" -> null，否则转数字（时刻、权重、份额、阈值都走这里）
export function num(value) {
  if (value === null || value === MISSING) return null
  const n = Number(value)
  if (Number.isNaN(n)) throw new Error(`无法解析为数字: ${value}`)
  return n
}

// "P1-30" -> { period: "P1", seq: 30 }，用于同对象多次报送的先后比较
export function parseStamp(stamp) {
  const match = /^([A-Za-z0-9]+)-([0-9]+)$/.exec(stamp)
  if (!match) throw new Error(`无法解析报送时点: ${stamp}`)
  return { period: match[1], seq: Number(match[2]) }
}

export function laterStamp(a, b) {
  const sa = parseStamp(a)
  const sb = parseStamp(b)
  if (sa.period !== sb.period) {
    // 不同期之间按期名字典序（P0 < P1 < ...），同业务内比较通常同期
    return sa.period < sb.period ? b : a
  }
  return sa.seq >= sb.seq ? a : b
}

// "T1+T2" -> ["T1", "T2"]；"?" -> []（来源未给路径）
export function splitIds(value) {
  if (value === null || value === MISSING) return []
  return value.split('+').map((part) => part.trim()).filter(Boolean)
}

// 校验每张表字段一致且全部为字符串原始值
export function checkRawShape(tables) {
  const problems = []
  for (const [name, rows] of tables) {
    if (!Array.isArray(rows) || rows.length === 0) {
      problems.push(`${name}: 表为空或不是数组`)
      continue
    }
    const columns = Object.keys(rows[0])
    for (const [i, row] of rows.entries()) {
      const keys = Object.keys(row)
      if (keys.length !== columns.length || keys.some((k, j) => k !== columns[j])) {
        problems.push(`${name}#${i}: 字段与首行不一致`)
      }
      for (const [key, value] of Object.entries(row)) {
        if (typeof value !== 'string') {
          problems.push(`${name}#${i}.${key}: 原始值不是字符串`)
        }
      }
    }
  }
  return problems
}
