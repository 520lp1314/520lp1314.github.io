# 第三方资料与依赖

应用算法与 UI 为本项目实现，未复制研究时查看的拼豆项目算法。

| 名称 | 版本 | 用途 | 许可 / 来源 |
|---|---|---|---|
| image-q | 4.0.0 | 固定候选色板匹配、WuQuant、Floyd–Steinberg、CIEDE2000 | MIT；https://github.com/ibezkrovnyi/image-quantization |
| Lucide | 0.468.0 | 操作图标 | ISC；https://lucide.dev |
| jsPDF | 3.0.3 | 浏览器 PDF 导出 | MIT；https://github.com/parallax/jsPDF |

依赖许可全文见 `vendor/LICENSES.txt`。jsPDF bundle 含发行版的依赖代码，各自声明保留在 bundle 中。

## 色卡资料

- 社区 A：a31521424/pixel-to-beads 的 `src/mard-color.json`。该仓库声明 GPL-3.0，配色引用保留来源；数据原始归档见 `knowledge/sources/e78c22811272.json`。https://github.com/a31521424/pixel-to-beads
- 社区 B：Jett-Wu/Perler_Beads_Generator 的 `src/palette.ts` 中色卡数据，仅提取 code/HEX，不使用其算法。数据原始归档见 `knowledge/sources/63edd01f8963.json`。发布再分发前需核验该资料许可。https://github.com/Jett-Wu/Perler_Beads_Generator
- 两份资料检索于 2026-10-08，保留为社区候选配色，均非厂家校准 RGB。知识库中的单独文件包含更详细的可信度和版本标记。
- 用户芮小鸡图纸来自已有本地处理结果，`assets/reference-grid.json` 保持原始逐格数据，`assets/reference-chart.png` 为用户参考图。

离线打包用于本地使用；公开售卖或对外再分发前，应补齐色卡数据授权及所有适用许可要求。
