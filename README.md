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

## 口径与判定

所有数字在资料里都是字符串，`?` 表示未报，读取层统一解析；未报绝不按零处理，也不臆造为可达。

### 可达性状态（OD 粒度，多候选不重复计权）

一个起讫关系（canonical 货场群 + 货类 + 方向）只在同时满足两点时计作可达：

1. 当期存在货类兼容、换装成立、且各边实际开行（`run=yes`）并接受申报（`accept=yes`）的候选路径；
2. 当期回单证据为受理，且直达或接续成功。

状态分四档，回答“工程恢复但不收货”和“无报送记录”是两回事：

| 状态 | 含义 |
| --- | --- |
| `reachable` | 有兼容路径且有正向受理/接续证据 |
| `not_accepting` | 发站方向实际开行了同货类班线但不受理，或回单明确不受理/接续失败 |
| `no_service` | 当期无兼容候选路径（回程不装、工程未恢复等） |
| `pending_evidence` | 资料等待中：未报、未给路径或仍待核；不按零也不按可达 |

换装按 `(期,站,前序线,后续线,货类)` 取 `reported_at` 最新一条；`不足` 明确不可用，`有效/已更正` 还要核对到达后等待是否达到 `min_wait`。回单同理，同一关系以后续回单覆盖先前观察，历史保留可追溯。

### 指数与级别

- **合同指数（contractBasket）**：篮子与权重冻结在 `baseline`（固定基期货类、发站群、起讫权重），逐期用当期网络和回单重新判定，当期不回改权重。
- **可识别范围指数（observedScopeIndex）**：基期冷门线缺报时，只在有观察依据的权重范围内出报，并给 `observedCoverage` 覆盖度。
- **当期框架指数（currentFrame）**：用 `current_frame` 的当期篮子和权重，含新增起讫；与合同指数并列，不回写合同口径。
- **新增服务范围（newServices）**：当期框架里基期篮没有的关系单列，覆盖扩大不计作基期范围的服务改善。
- **级别 grade**：`index_policy` 的阈值与 `min_group` 发站群数同时满足才定级；甲可附开行路线，乙可附站点级，未定级只出合计。明细门控按整期全局级别，合作方在该级别下只能取自身权限范围。

### 比较与归因

两期比较要求共同的起讫关系，且两期都有受理/接续与货类观察依据；缺报关系先排除并在 `excluded` 列明，只就可识别范围比较。变化拆成：

- `service_loss / service_gain`：共同可识别范围内的真实可达性变化；
- `observation_coverage`：缺报或待核造成的口径变化；
- `scope_expansion`：当期框架新增关系（覆盖扩大）。

站场拆分/更名按 canonical 货场群识别共同关系，分站份额按当时框架事实解释，不回改历史；被拆开的货场只保留旧关系中当期仍有分站与货类观察的部分。

### 发布、权限与留痕

- 合作方按货类与区域（发站群或到站群任一在其区域）看数，只收自身范围小计；清单不含全局合计或补数，反推断检查防止从合计反推受限小计。
- 细分线路重新归类可保持总指数与总级别不变，只改变哪个合作方收到哪些线路（见 `test/reclassification.test.js`）。
- 未送达的表在归属/换装更正后按当前可比范围重出，修订号递增并写明原因；已确认收悉的表保留原版与修订原因，不向无权限合作方补发更正明细。
- 行业简报总数与同版分表通过 `reconcile` 逐关系对账。
- 追溯入口：`trace` 可从下降指数回查到业务断点/口径变动/待料，从站场走到所属报表与发出证据，从报表看到收悉与更正处置。

## 代码结构

- `src/io.js`：资料读取、字符串/未报/时点解析、原始形状与引用校验。
- `src/frames.js`：期别-框架对位、canonical 货场群与分站沿革、共同关系。
- `src/network.js`：运行图有向边、换装约束、候选路径枚举、回单标准化。
- `src/reachability.js`：OD 月度可达性四档判定。
- `src/index.js`：合同/可识别/当期框架指数、级别、共同范围比较与变化归因。
- `src/publish.js`：权限过滤、级别门控下的明细附带、发布修订安排、对账与反推断。
- `src/trace.js`：OD、站场、报表三条追溯链路。
- `src/pipeline.js`：端到端编排与追溯入口。
- `src/cli.js`：分析员命令行。

## 运行

使用 Node.js 22。项目无需下载第三方依赖。

```sh
npm ci --offline --ignore-scripts
npm test
```

`npm run data:check` 检查合成资料能否读取并核对相关记录的引用。资料校验脚本可以独立运行。

## 分析员命令

```sh
node src/cli.js check                       # 资料形状与跨表引用校验
node src/cli.js index [--period P1]         # 月度指数、级别、新增服务
node src/cli.js compare                     # 相邻期共同范围比较与归因
node src/cli.js release [--period P1]       # 权限发布清单、修订安排、对账
node src/cli.js trace --od O2 --period P1   # 回查单个起讫关系
node src/cli.js trace --station S2a         # 站场沿革到报表与发出证据
node src/cli.js trace --report R2           # 报表收悉与更正处置
node src/cli.js build --out out             # 生成全套 JSON 产物
```

## 接到下一期运行图/报送资料时

1. 把新一期各表按既有字段追加到 `data/`（期别与框架版本各自排序对位，无需改代码）；
2. 运行 `node src/cli.js check`，确认无形状与引用问题；
3. 运行 `npm test` 回归既有口径；
4. 运行 `node src/cli.js build` 生成新一期指数、比较、发布与追溯产物；
5. 对 `待发` 报表先确认共同范围对账通过再发，`收悉` 后的更正只留痕不补发。

