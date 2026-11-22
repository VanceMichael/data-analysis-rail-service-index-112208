import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

const tableNames = ["frames", "baseline", "schedules", "transfers", "reporting", "index_policy", "journey_observations", "current_frame", "report_receipts"]
const records = new Map()

for (const name of tableNames) {
  const file = new URL(`../data/${name}.json`, import.meta.url)
  records.set(name, JSON.parse(await readFile(file, 'utf8')))
}

test('每张来源表保留一致的字段及原始值格式', () => {
  for (const [name, rows] of records) {
    assert.ok(rows.length > 0, name)
    const columns = Object.keys(rows[0])
    for (const row of rows) {
      assert.deepEqual(Object.keys(row), columns, name)
      assert.ok(Object.values(row).every(value => typeof value === 'string'), name)
    }
  }
})

test('关联的来源记录保留各自的引用字段', () => {
  const [left, leftKey, leftId, right, rightKey, rightId, leftField, rightField] =
    ["frames", "canonical", "H2", "baseline", "origin", "H2", "version", "weight"]
  const leftRows = records.get(left).filter(row => row[leftKey] === leftId)
  const rightRows = records.get(right).filter(row => row[rightKey] === rightId)
  assert.ok(leftRows.length > 0)
  assert.ok(rightRows.length > 0)
  assert.ok(leftRows.every(row => row[leftField]))
  assert.ok(rightRows.every(row => row[rightField]))
})


test('运行图引用本期站场框架，复报时间可与收悉回单区分', () => {
  const versionForPeriod = { P0: 'V1', P1: 'V2' }
  const stationVersions = new Set(records.get('frames').map(row => `${row.station}/${row.version}`))
  for (const row of records.get('schedules')) {
    const version = versionForPeriod[row.period]
    assert.ok(stationVersions.has(`${row.from_station}/${version}`), row.route)
    assert.ok(stationVersions.has(`${row.to_station}/${version}`), row.route)
  }
  for (const row of records.get('transfers')) {
    assert.match(row.reported_at, /^P[01]-[0-9]+$/)
    assert.equal(row.reported_at.split('-')[0], row.period)
  }
  const receipt = records.get('report_receipts').find(row => row.report === 'R2')
  const revisions = records.get('transfers').filter(row => row.from_route === 'T4')
  assert.equal(new Set(revisions.map(row => row.reported_at)).size, revisions.length)
  assert.ok(revisions.some(row => row.reported_at < receipt.at))
  assert.ok(revisions.some(row => row.reported_at > receipt.at))
})
