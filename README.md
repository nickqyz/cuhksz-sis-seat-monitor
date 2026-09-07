# CUHK(SZ) SIS 课程名额微信提醒

这是只读、全自动的名额监控器。它会通过学校 Web VPN 自动登录 SIS，查询 `2026-27 Term 1` 的以下课程组合，并在同一组合内的 Lecture 与 Tutorial **同时开放且确有剩余容量**时分别发送微信通知：

- `GEA 2000`：`L09` + `T23`
- `GFH`：`L04` + `T11`

脚本不会点击“加入购物车”、选课或注册按钮。默认每 120 秒检查一次，只在状态从未开放变为同时开放时通知一次；满员后再次开放会再次通知。

## 当前已确认状态（2026-09-07）

- L09：Closed，100/100
- T23：Closed，25/25；页面显示剩余名额可能受保留配额限制

## 微信通知还需一次性绑定

推荐使用 WxPusher 极简推送：打开 <https://wxpusher.zjiecode.com/>，微信扫描“极简推送 SPT”二维码并复制 `SPT_...`。拿到 SPT 后运行：

```powershell
.\save-secrets.ps1 -Username "你的学号" -Password "你的密码" -WxPusherSpt "你的SPT"
.\test-notify.ps1
```

账号、密码和 token 会通过 Windows DPAPI 加密后保存在 `.data/secrets.json`，只能由当前 Windows 用户解密。

## 运行

双击 `start-monitor.cmd`，或执行：

```powershell
.\run-monitor.ps1
```

运行日志在 `.data/monitor.log`，最近一次状态在 `.data/last-result.json`。监控保持 Edge 无头运行；登录会话过期后会自动重新登录并继续。

## 开机登录后自动启动

完成微信测试后，以 PowerShell 运行：

```powershell
.\install-task.ps1
```

它会创建当前用户登录后自动启动的任务并立即启动。若要移除：

```powershell
.\remove-task.ps1
```

## 电脑关机后继续运行

仓库包含 `.github/workflows/monitor.yml`，可在 GitHub Actions 上每 5 分钟执行一次。将仓库设为公开，并在仓库 Actions Secrets 中添加 `SIS_USERNAME`、`SIS_PASSWORD`、`WXPUSHER_SPT`；敏感值不会写入代码。工作流用缓存保存上次状态，避免名额持续开放时每 5 分钟重复通知。

## 安全

不要分享 `.data` 目录。你曾在聊天中发送过 SIS 密码；配置完成后建议更换密码，再重新运行 `save-secrets.ps1` 更新本机加密凭据。
