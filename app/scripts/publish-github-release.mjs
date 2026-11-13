import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { unzipSync } from "fflate";

// Owner-authorized publication of this exact, previously verified local release.
// A token is decrypted only in memory; never put in argv, files, logs or reports.
const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repo = path.dirname(app);
const repository = "copypasteltd/data-collect-extension", tag = "v0.3.0";
const commit = "9abce787e6ecc777ec4c9c8934012dd4832d605b";
const api = "https://api.github.com/repos/" + repository;
const output = path.join(repo, "docs/交付/2026-11-13/native-release");
const runFile = promisify(execFile);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const mode = process.argv[2] || "check";
assert(["check", "publish", "verify"].includes(mode), "Usage: publish-github-release.mjs check|publish|verify");
const downloadBase = "https://github.com/" + repository + "/releases/download/" + tag + "/";
const description = [
  "## 逻辑记录 v0.3.0", "",
  "已在 Windows 原生环境完成编译与真实验证，保留开始、停止、选择批次和导出四项主要操作。本次发布的是此前交付的同一组已验证字节，不重新编译。", "",
  "## 下载", "",
  "- **推荐：[完整 release 交付包](" + downloadBase + "logic-recorder-release-v0.3.0.zip)**：扩展、解析工具、安装/更新说明、真实验收与校验清单。",
  "- [仅 Chrome 扩展](" + downloadBase + "logic-recorder-chrome-v0.3.0.zip)：解压后加载，录制端无需 Node.js/Python。",
  "- [独立解析工具](" + downloadBase + "extension-logic-clone-v0.3.0.zip)：Python 3.9+ 标准库。",
  "- [完整包 SHA-256](" + downloadBase + "logic-recorder-release-v0.3.0.zip.sha256) · [包内各文件校验清单](" + downloadBase + "SHA256SUMS.txt)", "",
  "## 主要修复", "",
  "- 独立批次确认，区分确定失败与提交未知，保留采集中止后的核验状态。",
  "- 统一 JS/Python 分段终态、UTF-16、安全整数、Failure 和 End 后额外片检查。",
  "- 会话归属、迟到任务隔离、写入封存与导出水位一致性；修复停止封存读取无等待边界。",
  "- 跨来源字段字典、版本来源与固定大小诊断。",
  "- 停止/导出控制分离，下载确认增加事件/轮询和有界等待。", "",
  "## 实际验证", "",
  "| 项目 | 结果 |", "| --- | --- |",
  "| 生产编译 | 通过 |", "| JavaScript 回归 | 310/310，0 失败/取消/跳过 |",
  "| Python 消费者 | 12/12 |", "| 完整采集矩阵 | 50/50，0 跳过，前后候选身份一致 |",
  "| Chrome 生命周期重点命令 | 最新 9/9 通过；21 次执行、6 次失败历史保留 |",
  "| 合成 ERP 业务闭环 | 通过：5 个业务请求、321 条事件、15 个附件；余额 100000→87200 分，拒绝扣款不改变余额 |",
  "| 精确安装包 | 11 个扩展文件、7 个技能文件逐字节核对；未修改 manifest 的解压包实际加载、包内 Python CLI 校验通过 |", "",
  "环境：Windows x64 / Chrome 157.0.8103.40 / Node 24.22.1 / npm 10.9.2。",
  "最终 60 秒合成负载：额外 300 节点、120 KB 响应、35 次输入/请求；停止 15.755 秒，导出 30.105 秒，ZIP 22815318 字节，外部索引 5.192 秒。仅为该本机样本，不外推任意站点或规模。", "",
  "[验收报告](" + downloadBase + "RELEASE-REPORT.md) · [机器验证记录](" + downloadBase + "VERIFICATION.json) · [精确包检查](" + downloadBase + "package-smoke.json)", "",
  "## 安装与更新", "",
  "解压扩展 ZIP，在 chrome://extensions 启用开发者模式，选择“加载已解压的扩展程序”，选择直接包含 manifest.json 的目录。",
  "更新前先停止并导出需要保留的批次，覆盖原加载目录后刷新，避免卸载清除本地数据。[完整安装说明](" + downloadBase + "INSTALL.md)。", "",
  "## 重要边界", "",
  "- 默认涉及同一 Chrome profile 中所有已授权普通 HTTP(S) 网页、窗口及新标签；关闭侧边栏不会停止后台录制。",
  "- 记录和索引保留原值，可能含密码、Cookie、令牌及业务资料；ZIP 未加密，不主动上传，需自行保护本机与分享权限。",
  "- 不增加内容查看、导入、回放或自动删除。截图、Canvas、浏览器存储采样仍可能有缺口，ready 不等于全部证据完整。",
  "- macOS、最低 Chrome 125、原生权限弹窗和真实客户 ERP 未实测；不保证任意时长、大小、未访问分支或服务端源码恢复。",
  "- 哈希用于字节一致性，不是发布者数字签名。按用户要求未建设或切换 OS 隔离环境。", "",
  "Source commit: " + commit, "",
  "完整交付包 SHA-256: f9862c8a2803f9725af0b2cf1a4b17978444102f3c34c6ecd983091a96ae7fcc", ""
].join("\n");
const files = [
  ["release/logic-recorder-release-v0.3.0.zip", "f9862c8a2803f9725af0b2cf1a4b17978444102f3c34c6ecd983091a96ae7fcc"],
  ["release/v0.3.0/logic-recorder-chrome-v0.3.0.zip", "fbcd9f444c3a80a54685733bc89daa69a3808a49563297bf2f91c0b9387552bc"],
  ["release/v0.3.0/extension-logic-clone-v0.3.0.zip", "e2d1d5bf1c9f64c9196ae5294bdfe4b3c56d5236455ab448c7fbf3877d144182"],
  ["release/v0.3.0/SHA256SUMS.txt"], ["release/logic-recorder-release-v0.3.0.zip.sha256"],
  ["release/v0.3.0/INSTALL.md"], ["release/v0.3.0/RELEASE-REPORT.md"],
  ["release/v0.3.0/VERIFICATION.json"], ["release/v0.3.0/release-manifest.json"], ["release/v0.3.0/package-smoke.json"]
];
const assets = [];
for (const [relative, expected] of files) {
  const filename = path.join(app, relative), stat = await fs.lstat(filename);
  assert(stat.isFile() && !stat.isSymbolicLink(), "ordinary_release_file_required");
  const bytes = await fs.readFile(filename), digest = sha(bytes);
  assert(!expected || expected === digest, "verified_artifact_changed: " + path.basename(relative));
  assets.push({ name: path.basename(relative), filename, bytes, size: bytes.length, sha256: digest });
}
const bundle = unzipSync(assets[0].bytes), prefix = "logic-recorder-v0.3.0/";
for (const line of Buffer.from(bundle[prefix + "SHA256SUMS.txt"]).toString("utf8").trim().split(/\r?\n/)) {
  const [digest, name] = line.split("  ");
  assert(bundle[prefix + name] && sha(bundle[prefix + name]) === digest, "bundle_checksum_mismatch");
}
const verification = JSON.parse(assets.find((asset) => asset.name === "VERIFICATION.json").bytes);
const smoke = JSON.parse(assets.find((asset) => asset.name === "package-smoke.json").bytes);
assert(verification.status === "native-candidate-validation-passed" && smoke.status === "passed", "release_acceptance_not_passed");
let token;
const tokenFile = path.join(app, ".release-token.enc");
try {
  const command = "$ErrorActionPreference='Stop';$secure=ConvertTo-SecureString ([IO.File]::ReadAllText('" + tokenFile.replaceAll("'", "''") + "').Trim());$ptr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure);try{[Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr))}finally{[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)}";
  const result = await runFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { timeout: 15000, maxBuffer: 32768, windowsHide: true });
  token = result.stdout.trim();
  assert(token.length >= 20 && !/\s/.test(token), "release_auth_invalid");
} catch { throw new Error("release_auth_unavailable: encrypted credential could not be read with the current Windows account"); }
async function github(url, { method = "GET", data, bytes, contentType, allow404 = false } = {}) {
  const target = new URL(url);
  assert(["api.github.com", "uploads.github.com"].includes(target.hostname) && target.protocol === "https:", "credential_destination_rejected");
  const response = await fetch(target, { method, redirect: "error", signal: AbortSignal.timeout(120000),
    headers: { Authorization: "Bearer " + token, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "logic-recorder-owner-release",
      ...(data ? { "Content-Type": "application/json" } : {}), ...(contentType ? { "Content-Type": contentType } : {}) },
    body: data ? JSON.stringify(data) : bytes });
  if (allow404 && response.status === 404) return null;
  const body = await response.json();
  if (!response.ok) throw new Error("github_api_" + response.status + ": " + String(body.message || "request_failed").slice(0, 250));
  return body;
}
try {
  const repositoryInfo = await github(api);
  assert(repositoryInfo.full_name === repository && repositoryInfo.permissions?.push, "release_repository_write_permission_required");
  const current = await github(api + "/commits/" + commit);
  assert(current.sha === commit, "verified_commit_not_found");
  const existingRef = await github(api + "/git/ref/tags/" + tag, { allow404: true });
  if (existingRef) {
    let object = existingRef.object;
    if (object.type === "tag") object = (await github(api + "/git/tags/" + object.sha)).object;
    assert(object.type === "commit" && object.sha === commit, "existing_tag_targets_another_commit");
  }
  let existing = await github(api + "/releases/tags/" + tag, { allow404: true });
  if (!existing) {
    const list = await github(api + "/releases?per_page=100");
    existing = list.find((release) => release.tag_name === tag) || null;
  }
  console.log(JSON.stringify({ mode, repository, private: repositoryInfo.private, commit,
    existing: existing ? { id: existing.id, url: existing.html_url, tag: existing.tag_name, draft: existing.draft, prerelease: existing.prerelease,
      assets: existing.assets.map(({ name, size, digest }) => ({ name, size, digest })) } : null,
    plannedAssets: assets.map(({ name, size, sha256 }) => ({ name, size, sha256 })) }));
  if (mode !== "check") {
    let release = existing;
    if (mode === "publish") {
      if (!release) release = await github(api + "/releases", { method: "POST", data: { tag_name: tag, target_commitish: commit,
        name: "v0.3.0 — 逻辑记录", body: description, draft: true, prerelease: false } });
      // Never overwrite published bytes or delete an existing asset to force a match.
      for (const local of assets) {
        const remote = release.assets.find((asset) => asset.name === local.name);
        if (remote) {
          assert(remote.size === local.size && remote.digest === "sha256:" + local.sha256, "existing_asset_mismatch: " + local.name);
          continue;
        }
        assert(release.draft, "published_release_missing_asset: refuse_unreviewed_modification");
        const upload = release.upload_url.replace(/\{.*$/, "") + "?name=" + encodeURIComponent(local.name);
        const uploaded = await github(upload, { method: "POST", bytes: local.bytes,
          contentType: local.name.endsWith(".zip") ? "application/zip" : local.name.endsWith(".json") ? "application/json" : "text/plain; charset=utf-8" });
        assert(uploaded.state === "uploaded" && uploaded.size === local.size && uploaded.digest === "sha256:" + local.sha256,
          "uploaded_asset_digest_mismatch: " + local.name);
        console.log(JSON.stringify({ uploaded: local.name, size: uploaded.size, digest: uploaded.digest }));
      }
      if (release.draft) release = await github(api + "/releases/" + release.id, { method: "PATCH", data: { body: description, draft: false, prerelease: false, make_latest: "true" } });
    }
    assert(release && !release.draft && !release.prerelease, "public_stable_release_required");
    release = await github(api + "/releases/" + release.id);
    const checked = [];
    for (const local of assets) {
      const remote = release.assets.find((asset) => asset.name === local.name);
      assert(remote?.state === "uploaded" && remote.size === local.size && remote.digest === "sha256:" + local.sha256, "remote_asset_metadata_mismatch");
      const response = await fetch(remote.browser_download_url, { redirect: "follow", signal: AbortSignal.timeout(120000), headers: { "User-Agent": "logic-recorder-release-verification" } });
      assert(response.ok, "public_asset_download_" + response.status);
      const downloaded = new Uint8Array(await response.arrayBuffer());
      assert(downloaded.length === local.size && sha(downloaded) === local.sha256, "public_asset_checksum_mismatch");
      checked.push({ name: local.name, size: local.size, sha256: local.sha256, url: remote.browser_download_url });
    }
    const ref = await github(api + "/git/ref/tags/" + tag);
    let resolved = ref.object;
    if (resolved.type === "tag") resolved = (await github(api + "/git/tags/" + resolved.sha)).object;
    assert(resolved.type === "commit" && resolved.sha === commit, "published_tag_commit_mismatch");
    const result = { schemaVersion: 1, status: "published-and-public-downloads-verified", repository, tag, commit,
      releaseId: release.id, releaseUrl: release.html_url, publishedAt: release.published_at, verifiedAt: new Date().toISOString(),
      draft: release.draft, prerelease: release.prerelease, assets: checked, unchangedPreviouslyVerifiedArtifacts: true };
    await fs.writeFile(path.join(output, "GITHUB-RELEASE.json"), JSON.stringify(result, null, 2) + "\n");
    console.log(JSON.stringify(result));
  }
} finally { token = undefined; }
