# 独立接收者：仅记录包重建验收

## 结论

**PASS — 本地合成业务示例已实现并真正运行，13/13 原生 Chrome UI 检查通过。** 不是只校验 schema/hash 或 JSON 自比；不声称恢复原站源码或像素完整网站。

只读 AGENTS 与授权 ZIP 的 manifest/events/contents；未读 fixture、生产源码、其他会话 docs、原始合成站点、用户 Chrome profile。没有安装依赖、隔离环境、再委派、提交、推送或发布。

## 来源

- old 重建源：[round-1.zip](<../../../app/test-flow-acceptance-i030YS/round-1.zip>)，SHA-256 2a97443d4aa8fe18df9efdfb822302924f7c2db6f8fffbba4211c508474ae139；v3，70 events，35/35 content size+hash 通过。
- final 只读兼容源：[round-1.zip](<../../../app/test-flow-acceptance-8NQJdR/round-1.zip>)，SHA-256 18e661b50107c39c209dc1a1d5e6d318e51aa1f2cc4e6e7f6cedb1a6d0bdcc9e；80 events，36/36 contents、41 event refs 通过。不是第二版重建UI验收。
- 不消费 integrity.json。完整 ZIP hash 固定输入，内容按 manifest 校验。每个 event ID、包内行号与内容hash见 [provenance](<../../../app/test-flow-blind-reconstruction-030receiver/provenance.json>)、[结构化报告](<reconstruction.json>)。
- old coverage 为 policyGaps=1 / child_gesture_unconfirmed；final 为0。均不推断全业务完整。

## 真实 UI 结果

自有 Chrome 157.0.8103.40 / Playwright / headless，全新非持久化 context，不用 extension、不复用用户 profile。32个页面请求唯一 origin 为 http://127.0.0.1:11141；外网请求0、page errors0；仅一个预期409 console错误。

| 真实分支 | 结果 | old event seq（等于 timeline/events-00001.jsonl 行号） |
|---|---|---|
| canonical DOM/CSS、初始 forms properties | PASS | 2,3,4,5,52 |
| Query member 两次，余额100000 | PASS | 9–15 |
| Contact 13800000000→13900001234，Unicode note 空→预约💆‍♀️ — synthetic note 🧾 | PASS | 17–19 |
| 空 Operator 提交，原生 invalid、聚焦、PUT新增0 | PASS | 21–24 |
| 打开 dialog、下拉 facial、确认关闭 | PASS | 25–28,34 |
| 填 synthetic-operator，PUT JSON /200/可见成功结果 | PASS | 29–35 |
| POST amount12800 /201，100000→87200 | PASS | 36–39 |
| POST amount9000000 /409，INSUFFICIENT_BALANCE，余额不变 | PASS | 40–44 |
| iframe frame-before→frame-after、lookup200 | PASS | 3,45–49,67 |
| 实际popup child-before→child-after、lookup200 | PASS | 50–58,63,68 |
| Recheck200，contact/note/余额87200仍保持 | PASS | 60–66 |
| success snapshot34 属性与旧attribute分开还原 | PASS | 34 |
| 原script全部移除，仅新本地脚本、无事件属性/外部URL | PASS | 2,5及本地DOM审计 |

明细：[test-results.json](<../../../app/test-flow-blind-reconstruction-030receiver/test-results.json>)；测试：[test.cjs](<../../../app/test-flow-blind-reconstruction-030receiver/test.cjs>)；[本地最终画面](<../../../app/test-flow-blind-reconstruction-030receiver/local-final.png>)（辅助，不断言像素相等）。

## HTTP样本来源

查询参数均为 round=1，origin 只映射到自有mock。

| 样本 | 事件 | request → response content SHA-256 |
|---|---|---|
| GET member初值 | 10→11 | 无请求体 → 874cd46ba2fb67bdb52bcf8f49add7147990dfb780271d11b6cfb415d0d126c0 |
| PUT member200 | 30→33 | d6a744507c5e09bfd42d220efecb79729563703699a626622b76f8a840e91040 → 5815521c4729582a7b5767013660cdb33ab258ba7f1d863a026dc6d67a9c0b4d |
| POST debit201 | 37→38 | a29304ec62754781a4fa3766733cadb8163af3edbf712ae86f7917b564492adf → b8f5fa2b2fc5be82131fd875fc52ca4e7accc339fa8d743f58294ff288ba9efc |
| POST excessive409 | 41→42 | 3a8f29c0aaff01148aa216176e2ca8baaf6c247a392b11e2966014dce65b1a93 → 6865ec35f5c494ed591862f9bdfe0377d2e4f3ed2acda5cfb76d88e23973daf9 |
| GET frame200 | 46→48 | 无请求体 → da4e1f298db2635071f426c39d2e14a6a50e4c4b62ddc0683eecdf130a03fea3 |
| GET member最终200 | 61→62 | 无请求体 → 2320cdb6d006a642d40aa5f0bbe04f7eea74d200b6a897672eb860a43e15dc1f |

## 页面身份

- root：tab 342464505 / frame 0 / document 542E4321E87817F499A8184A3D66DD48；event 34df4ee3-5f45-47b0-9985-dd5ca140ac98:event:2，DOM hash 1965967761606a50296a354187338a97ae1a519fb78aaa12d71cedbed05cb86c。
- iframe：tab 342464505 / frame 25 / document C3EBF82F0042E5082A60FD19C3EB8589；event 34df4ee3-5f45-47b0-9985-dd5ca140ac98:event:3，DOM hash c3efa644461cc91c2c83db54807e3a8afd56ff2419a47e7b8be873a88e1beac6。
- child：tab 342464507 / frame 0 / document EEC21D64468745B434173DC7665C1E21；event 34df4ee3-5f45-47b0-9985-dd5ca140ac98:event:52，DOM hash 313e0c25540663d593ef35aeda0d41cd0ccf3efa82908db1c1693d7215d85646。

## 为可运行性补全的实现（不是采集事实）

- canonical snapshots 2/3/52 supply captured DOM; 17 snapshots are preserved as sanitized local views. DOM is observed serialization, not original server source.
- Original script/style elements, handlers, actions, external URLs are stripped. CSS escapes normalize before import/URL/image-set/expression removal. CSS URL becomes none. An exact iframe path maps only to mock.
- New snapshot-state.js restores recorded forms properties independently of old HTML value attributes. New reconstruction.js authors submit/button handlers, showModal/close and local fetch.
- In-memory mock accepts exact observed PUT/debit samples in observed order. Other input/order returns implementation-only UNKNOWN_UNOBSERVED_SAMPLE, not an invented original error.
- Page identity numbers remain evidence metadata, not actual runtime tab/frame/document IDs of newly launched Chrome.
- Clock is frozen; original timing, scrollbars, native validation popup pixels and pixel-perfect equivalence are not reconstructed.

## Unknown / 未覆盖

- Original JavaScript/backend source, auth/session rules, hidden/unvisited branches and complete API schema/server requiredness are unknown.
- Only missing-operator validation was exercised. Contact required exists in DOM but missing-contact branch is unobserved. Controls observed disabled=false; disabled=true branch is unknown.
- No create-member business is recorded. This reconstructs the existing synthetic member form, not an invented registration workflow.
- CSSOM and viewport PNG exist; full computed styles, fonts, canvas and full-page PNG are not collected. No pixel-complete claim.
- Old source records child_gesture_unconfirmed gap despite scope.child event linkage. Final source records zero gaps, not proof of all states.
- Operation/network adjacency guides new handlers; seq/time is not asserted to be strict causality.

## final 兼容，只读不混充UI通过

- 9个old HTTP样本全部在final原值匹配，见 [final-compatibility](<../../../app/test-flow-blind-reconstruction-030receiver/final-compatibility.json>)。
- event55 iframe25 导航到新document 82E6B94A0FDA2DDBD1D055C32B817854；event57 DOM hash 65ddd36bb63f82ebac37e628347323e9b5683c07feab86b26b8f6e339f5c128f。根document保持8443A944B3ECC09ED2E21FD9E3C2D9C8。
- event60 明示根frame0 Contact 13900001234→13700005678；没有再次保存的证据，不把输入误当服务器member已变为137…。
- event23/25 transient_state added/removed 都保存原文 Synthetic approval required — visible for 200ms ⚠️；event24 DOM也保存，hash 05f51690827f11c4a1ce3ddaec60a1bfb04da1647e5cbaaa6a4b43d90229ff98。这里不计入old UI的13项。

## 复建与收束

从仓库根依次运行（已有依赖，无需install）：

    python app/test-flow-blind-reconstruction-030receiver/build.py
    python app/test-flow-blind-reconstruction-030receiver/server.py
    # 另一终端：
    node app/test-flow-blind-reconstruction-030receiver/test.cjs

启动打印动态loopback URL，手动入口 /root?round=1。每次完整重测先重启mock复位。其他样本明确UNKNOWN_UNOBSERVED_SAMPLE，不推测原站分支。

首遍到popup时测试监听器 request.frame() 暂不可用失败；修监听器后全新mock+Chrome重跑，job bash-83d1431ba8724611 exit0、13/13 PASS。首遍失败未计通过。

成功测试 browser.close 已完成；两个自有server job均kill+collect，端口11141 connect_ex=10061（连接拒绝）。不关闭用户浏览器。代码/PNG/索引只在ignored测试目录，报告只写指定docs。
