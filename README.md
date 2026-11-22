# 线路修复分批开通的班列可达性指数

返回方向独立登记；基期量为冻结业务权重。权重保存在 OD 粒度，统计框架给出分站对应业务能力。 所有资料均为合成记录。文件编码为 UTF-8，数字、日期及标记在原始记录中均以字符串保存。问号表示来源未能提供该值；加号分隔来源系统使用的组合编号。

## 资料

固定基期权重按允许货类和方向登记，时刻为当地分钟，换装时等于最短间隔可用。标记问号的是未报，不作零。行业简报的级别来自 index_policy，允许的明细仍受收件合作方权限约束。

- `frames.json` 记录字段为 `station`、`version`、`canonical`、`regional`、`share`、`cargo`。
- `baseline.json` 记录字段为 `od`、`origin`、`destination`、`cargo`、`weight`、`framework`。
- `schedules.json` 记录字段为 `period`、`route`、`from_station`、`to_station`、`cargo`、`depart`、`arrive`、`accept`、`run`。
- `transfers.json` 记录字段为 `period`、`station`、`from_route`、`to_route`、`cargo`、`min_wait`、`state`、`reported_at`。
- `reporting.json` 记录字段为 `report`、`period`、`scope`、`recipient`、`permission`、`current`、`state`。
- `index_policy.json` 记录字段为 `grade`、`min_index`、`detailed`、`min_group`。

- `journey_observations.json` 记录字段为 `observation`、`period`、`od`、`routes`、`cargo`、`request`、`connection`、`delivery`、`reported_at`。
- `current_frame.json` 记录字段为 `period`、`od`、`origin`、`destination`、`cargo`、`weight`、`framework`。
- `report_receipts.json` 记录字段为 `report`、`revision`、`at`、`event`、`recipient`、`material`。

journey_observations 为托运代理回单。current_frame 给出当期业务框架。report_receipts 为收件记录，reporting 的 current 对应报表口径版本。P0 和 P1 为连续两个报送期，后缀为期内记录次序。P0 使用 V1 站场框架，P1 使用 V2。站场框架中的 cargo 是统计框架登记的主要货类，具体一班能办理的货类见运行图。换装表按 reported_at 记录各次报送。托运回单以期别、起讫编号和运行路径关联，后续回单可更新先前的观察。

## 运行

使用 Node.js 22。项目无需下载第三方依赖。

```sh
npm ci --offline --ignore-scripts
npm test
```

`npm run data:check` 检查合成资料能否读取并核对相关记录的引用。资料校验脚本可以独立运行。
