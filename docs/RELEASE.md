# 发布流程

## 前置条件（一次性）

1. 仓库 **Settings → Secrets and variables → Actions** 配置 4 个签名 Secret
   （见 `SECURITY.md` 的轮换步骤）。**旧 keystore 已泄露，禁止继续使用。**
2. `main` 分支保护可选：建议要求 CI 绿灯才能合并。

## 发布一个版本

版本号**只改 `package.json` 一处**，`versionCode`、Expo `version`、App 内显示版本
全部由 `app.config.js` 自动推导。

```bash
# 1. 改版本（例：1.3.0）
#    package.json -> "version": "1.3.0"

# 2. 更新 CHANGELOG.md：把待发布小节标题改为 ## vX.Y.Z - YYYY-MM-DD

# 3. 本地验证
npm ci
npm run typecheck
npm test

# 4. 提交并打 tag（tag 必须是 v + package.json 版本，否则 CI 直接失败）
git add -A
git commit -m "release: v1.3.0"
git tag v1.3.0
git push origin main --tags
```

tag push 触发 `build-apk.yml`：

1. 校验 `tag == v$(package.json.version)`；
2. `npm ci` + typecheck + 单元测试；
3. `expo prebuild` + 打 Release APK（Secrets 注入签名）；
4. `apksigner verify` 验签 → 生成 `SHA256SUMS`；
5. `gh release create v1.3.0`，附 APK + `SHA256SUMS`，
   Release 正文自动摘录 CHANGELOG 中该版本小节。

普通 push 到 `main` 只跑 `ci.yml`（typecheck + test），**不会**产生/覆盖 Release。

## 发布后检查清单

- [ ] Release 页面能看到 APK 与 `SHA256SUMS`
- [ ] `sha256sum -c SHA256SUMS` 本地校验通过
- [ ] `apksigner verify --print-certs` 指纹与上一版一致（证书未意外轮换）
- [ ] 已安装旧版的手机能收到更新提示并覆盖安装成功

## 回滚

GitHub Release 支持编辑：把出问题的 Release 标记为 pre-release 或删除对应 tag，
应用内检查更新取的是 `releases/latest`，会自动回到上一个稳定版本。
