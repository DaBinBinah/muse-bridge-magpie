# 发布步骤（三条路径，全部需要你手动执行）

本仓库已经把插件本体、说明和材料备齐并通过了全部本地检查。下面是从"本地
就绪"到"上架"的完整操作清单。三条路径互相独立、可以叠加。

**发布前自查**（每次更新都过一遍）：

```bash
npm run check                                    # 单测 + 加载检查全绿
git grep -inE "m2a-[A-Za-z0-9_-]{10,}"           # 不应命中任何真实 Key
git grep -inE "hatch_(sess|gw|vml)="             # 不应命中任何真实 Cookie
```

---

## 路径 0 · 创建插件仓库（两条 GitHub 路径的前提）

1. GitHub 上新建仓库 **`DaBinBinah/muse-bridge-magpie`**（与 package.json
   里的 repository 字段一致；不要 fork，topic 发现不收录 fork）；
2. 推送本目录：

   ```bash
   cd muse-bridge-magpie
   git init && git add -A && git commit -m "MuseBridge provider plugin for Magpie v1.0.0"
   git remote add origin https://github.com/DaBinBinah/muse-bridge-magpie.git
   git push -u origin main
   ```

3. 加 GitHub topic：仓库页 About ⚙ → Topics → 填 **`magpie-plugin`** →
   Save（也可以用 `gh repo edit --add-topic magpie-plugin`）。

几分钟后 Magpie「插件 → 发现 → 非官方插件 · GitHub」就会出现这个条目
（按 star 排序，标注"未审阅"；名称/简介/图标来自 package.json 的
`magpie` 字段，卡片上会标注"包自己的话"）。硬性条件本仓库已满足：
根目录有 package.json、插件文件直接提交在仓库里（零构建、源码即产物）、
不是 fork。

更新插件 = 改代码 → 改 package.json 版本（SemVer）→ 提交推送。Magpie
对比 GitHub 提交后会给已安装用户显示更新圆点。

> 想给仓库配社交预览图：Settings → General → Social preview → 上传
> （只能网页操作，无 API）。

---

## 路径 1 · npm 包（可选，方便按名字安装）

```bash
cd muse-bridge-magpie
npm login          # 网页注册/登录后生成 Access Token 更稳，见下方"npm 坑"
npm publish        # files 白名单已配好：只发 plugin.js / README / LICENSE
```

发布后用户 `magpie plugin add muse-bridge-magpie` 按名字安装；npm 上的
README 就是 Magpie 插件详情页正文。

**npm 坑速查**（2026-11 实测）：

- 新账号只能网页注册（API 注册已被禁）；网页注册可能被 IP 风控，换手机
  流量网络最有效；
- CLI 登录对新账号一律 401，正确做法是网页登录 → Access Tokens → 生成
  **Classic / Automation** 类型 token（自带 2FA bypass）→ 写进
  `~/.npmrc`；
- token 选 Granular 的话必须选 "Read and write"，stage-only 会静默发布成
  `0.0.0-stage` 占位；
- 搜索索引延迟几小时~一天，期间用确切包名直装仍然可用。
- **tarball CDN 晚于元数据**：publish 成功后 `dist-tags` 几十秒可见，但 `.tgz` 文件可能再延迟 1~2 分钟（期间更新会报 tarball 404）。发布后先 `curl -I` 确认 tarball 返回 200 再通知用户点更新。

---

## 路径 2 · 社区精选列表（可选，需 PR）

社区列表在 `magpie-community/plugins` 仓库的 `registry.json`，与上面两条
路径互相独立。条目草稿已备好：[`registry/registry-entry.json`](registry/registry-entry.json)。

1. 先完成路径 0（社区条目要指向真实存在的包）；
2. Fork `magpie-community/plugins` → 把
   `registry/registry-entry.json` 的内容（去掉 `_comment` 字段）追加进
   `registry.json` → 提 PR；
3. PR 描述里写清：功能、依赖（需要用户自建 MuseBridge 服务）、README 已
   如实声明"未经官方审核"。

合并前本仓库任何位置都**不得声称"已被社区收录"**（目前所有文案均为
"可申请/未审阅"口径）。

更彻底的贡献方式是把包搬进社区 monorepo（`packages/<name>`，供应商包命名
`@magpie-community/opencode-musebridge-auth`，要求零运行时依赖——本插件
本来就是零依赖），合并后由每个 Magpie 自动分发更新。这是后续可选项，不
影响前两条路径。

---

## 版本对应关系

| 本插件 | 适配的 MuseBridge 服务端 | 备注 |
|---|---|---|
| 1.0.x | ≥ 1.7.2 | 依赖服务端的 404 `model_not_found`（v1.7.2 起）与 `tools` 提示词模拟（v1.5.0 起）。服务端过旧时模型拒绝会变成 400，仅影响报错展示 |
