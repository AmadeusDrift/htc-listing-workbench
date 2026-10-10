# HTC 独立上架工作台 · 1.0.0

Windows / Electron / React / TypeScript 批量上架工作台的源码归档基线。

当前处于稳定性诊断后的计划审核阶段。建仓不代表已修复已知问题、完成真实上架验收或批准恢复生产任务。

## 文档导航

- [工作区导航与更新流程](docs/version-control/WORKSPACE_GUIDE.md)
- [每次更新必须提交的工作约定](AGENTS.md)
- [2026-10-10 合并与验证记录](docs/maintenance/2026-10-10-工作区合并与提交约定.md)
- [上传范围与排除清单](docs/version-control/REPOSITORY_INVENTORY.md)
- [不含真实运行数据的稳定化计划及回归清单](docs/version-control/STABILITY_PLAN.md)
- [逐文件清单与哈希](docs/version-control/repository-files.csv)

## 目录

| 目录 | 内容 |
|---|---|
| [src/](src/) | 桌面主进程、IPC、页面和共享业务契约 |
| [tests/](tests/) | 隔离测试及夹具 |
| [scripts/](scripts/) | 开发、构建和 E2E 工具 |
| [extension/](extension/) | 浏览器采集扩展 |
| [native-host/](native-host/) | Windows 通信宿主 |
| [samples/](samples/) | 示例及空凭据模板 |
| [docs/version-control/](docs/version-control/) | 稳定化计划、归档范围和文件清单 |

根目录保留 README、第三方声明、项目配置和启动脚本。启动脚本保持原位，避免改变相对路径。

本次不上传原始历史文档、真实调用日志、业务表格、商品素材、数据库或凭据。它们保留在原电脑。此仓库为源码归档，不是生产工作区备份。

## 安装与验证

使用 Windows 和 Node.js 24 或更高版本。原生宿主构建还需脚本指定的 Windows/.NET 环境。

```powershell
npm ci
npm run typecheck
node --test --test-concurrency=4 --test-timeout=60000 tests/*.test.ts
npm run build
```

首次接手先阅读代码与计划，不要直接启动旧任务或覆盖 AppData。测试中的 fixture/e2e/fake 凭据为合成占位值，不可用于真实服务。

初次归档时的历史审计记录为1572项：1571通过、1项符号链接权限相关跳过、0失败；不是当前版本、GitHub CI或真实可售证明。2026-10-10 已合入外出开发的 8 个提交至 3e2c652；本机类型检查及 31 项相关测试通过，具体范围见合并记录。

当前 npm run check 尚未覆盖稳定化计划要求的全部历史组合场景。新克隆缺少本机历史说明文档时的打包失败已由 1ada421 修复，缺失的可选文档会跳过。本轮未重新构建或打包；启动脚本优先使用 release 中的旧程序，源码更新不等于应用已部署。

## 后续修复约束

先复现，再编写失败测试，再修改，最后运行受影响测试及完整回归。不能为通过测试随意降低断言或改变业务预期。未知付费请求和未知提交不自动重发，原 SKU、图片及父子关系保持稳定。

仓库已公开，尚未选择开源许可证。第三方声明见 [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt)。
