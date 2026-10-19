# 配置说明

将根目录 `config.example.json` 复制为手机运行目录中的 `config.json`。仓库忽略本机配置，防止把个人设置和通知地址提交出去。示例配置不包含登录凭据。

## 页面与定位

| 配置 | 意义 |
|---|---|
| `app.package` | 目标App包名，当前 `me.ele` |
| `app.launchActivity` | 明确的启动组件；源码缺省为 `me.ele.Launcher`，示例文件缺失时由 `loadCfg()` 补默认值 |
| `app.readyKeywords` | 活动页文字线索，不能填首页也大量出现的泛词 |
| `app.homeEntryCoords` | 首页入口候选坐标，按顺序验证，不是通用定位 |
| `app.popupCloseCoords` | 已识别运营弹窗的历史关闭坐标；前台必须是目标App |
| `target.zone` | 只认可该区域内的领取候选控件，隔离场次标签 |
| `blindTap.coord` | 实际触控位置，当前样例为 `(899,849)` |
| `blindTap.anchorText/anchorCoord` | 页面结构锚点，锚点坐标应与锚点本身比较 |

默认示例基于1080×2340。改分辨率、字号、显示缩放或页面结构后必须重新校准；不是把坐标等比缩放就能保证正确。

锚点比较当前是提示性诊断：锚点缺失或偏移时会警告，并不会仅因这一项直接硬停。按钮几何预检另行判断，不能把 `anchorTolerancePx` 当成强制禁止触控的安全阈值。

## 调度与触控

除场次标签外，表中时间单位均为毫秒。

| 配置 | 本版示例 | 当前含义 |
|---|---:|---|
| `sessions` | 08/10/11/14/17/18/20点 | 按手机本地日期和时区生成目标时间；不是自动读取活动规则 |
| `timing.prestageMs` | 540000 | 提前进入本场调度 |
| `timing.enterBeforeMs` | 300000 | 提前摆好活动页 |
| `timing.lockBeforeMs` | 180000 | 提前锁定目标场次 |
| `timing.fireMode` | `timerBurst` | 完成预检后校准整点直接开始，不等可抢文案 |
| `timing.fireWindowMs` | 10000 | 截止于目标整点加该窗口 |
| `timing.pressDurationMs` | 10 | 领取触控使用短按；0回退 `click` |
| `timing.blindGapMs` | 20 | 每次触控返回后额外等待；不含API本身耗时 |
| `timing.blindMaxClicks` | 1000 | 异常保护上限，通常先到10秒截止 |
| `timing.captureFireFeedback` | true | 独立观察线程 |
| `timing.feedbackPollMs` | 250 | 观察轮次之间的额外等待，实际周期还包含检索耗时 |
| `timing.clickGapMs` | 250 | 旧 `state` 模式参数，不能当成当前timerBurst实际间隔 |

`leadMs`、`blindTapLeadMs`、`notstartRefreshAfter` 等保留字段来自旧分支；不能看到配置名称就假定默认timerBurst会提前出手或逐次刷新。修改前要对照 `doFire()` 实际分支和回归用例。

## 时间同步

`timeSync.enabled` 控制取样；`urls` 是时间源候选；`samples` 默认3；`budgetMs` 默认5000。请求优先使用独立OkHttp总调用超时，重新同步失败会保留已有校准。时间源的RTT不是领取接口延迟。

## 其他配置

`screenshots=false` 是现有设备无法取得AutoX截图权限的设置；本版诊断不依赖截图。`notify.webhook` 默认为空，不要把真实Webhook上传到公开仓库。成功通知以页面判定为触发条件，仍需要核验实际券包。

文件中的说明性字段保留历史背景，当前参数以实际JSON值为准。新配置字段会由 `loadCfg()` 补默认值，不一定立即写回磁盘。
