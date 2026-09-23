# 安全政策

## 支持版本

仅最新 Release 版本会收到安全修复。

## 报告漏洞

请**不要**直接公开 Issue 报告安全漏洞。请通过 GitHub 的
[Security Advisory → Report a vulnerability](https://github.com/846515182/SnoreSleepMonitor/security/advisories/new)
私下披露，或通过仓库 Issue 联系方式先建立私密沟通。

我们会在 72 小时内响应。

## ⚠️ 已知事件：签名密钥泄露（必须轮换）

仓库历史中曾以 `release.keystore.b64`（Base64）形式提交过发布用 keystore，
且 store/key 密码以明文写在 workflow 文件里。**任何拿到该文件与密码的人都可以
伪造与官方完全相同签名的 APK**（Android 覆盖安装只校验证书）。

该文件已从当前代码中删除，CI 改用 GitHub Secrets，但 **git 历史中仍然存在**。
因此：

### 轮换步骤（发布 v1.3.0 前必须完成）

1. 生成新密钥：

   ```bash
   keytool -genkeypair -v \
     -keystore release.keystore \
     -alias snoresleep \
     -keyalg RSA -keysize 2048 -validity 10000
   ```

2. 把新 keystore 与密码写入仓库 **Settings → Secrets and variables → Actions**：

   | Secret | 值 |
   | --- | --- |
   | `RELEASE_KEYSTORE_BASE64` | `base64 -w0 release.keystore` 的输出 |
   | `RELEASE_KEYSTORE_PASSWORD` | 新密码（不要复用旧密码） |
   | `RELEASE_KEY_ALIAS` | `snoresleep` |
   | `RELEASE_KEY_PASSWORD` | 新密码 |

3. **不要**把 keystore 或密码提交到仓库（`.gitignore` 已忽略 `*.keystore`）。
4. 本地离线备份新密钥（丢了无法再更新现有安装）。
5. 密钥轮换后，旧签名安装的用户无法覆盖安装新签名 APK，需要**卸载重装**。
   请在 Release 说明中明确告知。

### 可选：清理 git 历史

如需彻底移除历史中的密钥，可用 `git filter-repo` 重写历史（会使所有 commit hash 变化，
需协调所有协作者）。若仓库为公开且密钥已泄露，**优先做轮换**，历史清理是补充手段。

## 更新链路的纵深防御

应用内更新虽依赖 GitHub Releases，但叠加了四层校验：

1. 下载地址必须以本仓库 `releases/download/` 为前缀；
2. 下载文件大小与 GitHub 声明值相差不超过 ±1%；
3. 安装时由 Android 校验 APK 签名与已安装版本一致（证书轮换后此保护会重新对齐新证书）；
4. Release 附 `SHA256SUMS`，供用户人工核对。
