import { verifyMaterialsDirectory, verifyResourceMaterials } from "./materials-contract.mjs";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { verifyZip } from "./zip.mjs";

const exec = promisify(execFile);

async function walk(directory, relative = "") {
  const entries = [];
  for (const entry of await fs.readdir(path.join(directory, relative), { withFileTypes: true })) {
    const child = relative === "" ? entry.name : path.join(relative, entry.name);
    if (entry.isDirectory()) entries.push(...await walk(directory, child));
    else entries.push(child.split(path.sep).join("/"));
  }
  return entries;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/**
 * Inspect the actual .deb bytes: metadata, extracted install tree, sandbox
 * posture and the absence of browser-only or developer files.
 */
export async function verifyDeb(debPath, { workspaceVersion }) {
  const info = (await exec("dpkg-deb", ["--info", debPath], { maxBuffer: 16 * 1024 * 1024 })).stdout;
  assert(/^\s*Package: audivane$/m.test(info), ".deb package name is not audivane");
  assert(/^\s*Architecture: amd64$/m.test(info), ".deb architecture is not amd64");
  assert(/^\s*Depends: .*libgtk-3-0/m.test(info), ".deb does not declare the GTK runtime dependency");
  assert(/^\s*Depends: .*libc6 \(>= /m.test(info), ".deb does not declare a derived libc dependency");
  const versionLine = info.match(/^\s*Version: (.+)$/m)?.[1] ?? "";
  assert(versionLine.length > 0, ".deb has no version");
  const extraction = path.join(path.dirname(debPath), "verified-deb-root");
  await fs.rm(extraction, { recursive: true, force: true });
  await fs.mkdir(extraction, { recursive: true });
  try {
    await exec("dpkg-deb", ["-x", debPath, extraction], { maxBuffer: 64 * 1024 * 1024 });
    const app = path.join(extraction, "opt/audivane");
    assert(((await fs.stat(app)).mode & 0o777) === 0o755, ".deb install root is not world-traversable mode 0755");
    await fs.access(path.join(app, "audivane"));
    await fs.access(path.join(app, "resources/distribution.json"));
    await fs.access(path.join(app, "resources/native-bundle-manifest.json"));
    await fs.access(path.join(app, "resources/third_party/ffmpeg/bin/ffmpeg"));
    await fs.access(path.join(app, "resources/third_party/ffmpeg/bin/ffprobe"));
    await fs.access(path.join(app, "resources/third_party/ldac/bin/ldac_helper"));
    await fs.access(path.join(app, "LICENSE"));
    await fs.access(path.join(app, "LICENSES.chromium.html"));
    await fs.access(path.join(extraction, "usr/share/applications/audivane.desktop"));
    await fs.access(path.join(extraction, "usr/share/icons/hicolor/256x256/apps/audivane.png"));
    await fs.access(path.join(extraction, "usr/share/doc/audivane/THIRD_PARTY_NOTICES.md"));
    const apparmor = await fs.readFile(path.join(extraction, "etc/apparmor.d/audivane"), "utf8");
    assert(/profile audivane "\/opt\/audivane\/audivane" flags=\(unconfined\)/.test(apparmor), ".deb AppArmor profile is not scoped to the installed executable");
    assert(/^\s*userns,$/m.test(apparmor), ".deb AppArmor profile does not grant user namespaces");
    assert(!/\/\*\*|flags=\(complain\)|flags=\(enforce\)/.test(apparmor), ".deb AppArmor profile is broader than the reviewable userns attachment");
    const control = path.join(path.dirname(debPath), "verified-deb-control");
    await fs.rm(control, { recursive: true, force: true });
    await exec("dpkg-deb", ["-e", debPath, control], { maxBuffer: 16 * 1024 * 1024 });
    try {
      const postinst = await fs.readFile(path.join(control, "postinst"), "utf8");
      const prerm = await fs.readFile(path.join(control, "prerm"), "utf8");
      const postrm = await fs.readFile(path.join(control, "postrm"), "utf8");
      assert(/apparmor_parser -r \/etc\/apparmor\.d\/audivane/.test(postinst), ".deb postinst does not load the scoped AppArmor profile");
      assert(!/apparmor_parser[^\n]*\|\|\s*(true|echo)/.test(postinst), ".deb postinst conceals an AppArmor load failure");
      assert(/remove\|deconfigure/.test(prerm), ".deb prerm does not handle remove/deconfigure");
      assert(/apparmor_parser -R \/etc\/apparmor\.d\/audivane/.test(prerm), ".deb prerm does not unload the profile while the conffile exists");
      assert(/upgrade\|failed-upgrade/.test(prerm), ".deb prerm does not preserve the profile across upgrades");
      assert(!/apparmor_parser -R/.test(postrm), ".deb postrm unloads the profile after dpkg may have removed the conffile");
      assert(/^\/etc\/apparmor\.d\/audivane$/m.test(await fs.readFile(path.join(control, "conffiles"), "utf8")), ".deb conffiles does not preserve the AppArmor profile");
    } finally {
      await fs.rm(control, { recursive: true, force: true });
    }
    const link = await fs.lstat(path.join(extraction, "usr/bin/audivane"));
    assert(link.isSymbolicLink(), ".deb command is not a symlink");
    assert((await fs.readlink(path.join(extraction, "usr/bin/audivane"))) === "/opt/audivane/audivane", ".deb command points at an unexpected executable");
    const sandbox = await fs.stat(path.join(app, "chrome-sandbox"));
    assert((sandbox.mode & 0o4000) === 0, ".deb ships a setuid chrome-sandbox; no setuid workaround is permitted");
    const desktop = await fs.readFile(path.join(extraction, "usr/share/applications/audivane.desktop"), "utf8");
    assert(/^Exec=\/opt\/audivane\/audivane$/m.test(desktop), ".desktop launcher does not use the installed executable");
    assert(!/--no-sandbox/.test(desktop), ".desktop launcher disables the Chromium sandbox");
    const distribution = JSON.parse(await fs.readFile(path.join(app, "resources/distribution.json"), "utf8"));
    assert(distribution.version === workspaceVersion, ".deb packaged version disagrees with the workspace");
    assert(distribution.executable === "audivane", ".deb metadata does not describe the installed executable");
    assert(distribution.browserCodecAssets === "excluded-native-only", ".deb did not record browser asset exclusion");
    const materials = await verifyMaterialsDirectory(path.join(app, "resources"), "linux");
    const files = await walk(path.join(app, "resources"));
    const forbidden = files.filter(file => /(^|\/)(codec-assets\/|ffmpeg-core\.(js|wasm)$|lc3_codec\.(js|wasm)$|ldac_codec\.(js|wasm)$)/i.test(file));
    assert(forbidden.length === 0, `.deb still contains browser-only or developer files: ${forbidden.join(", ")}`);
    const native = JSON.parse(await fs.readFile(path.join(app, "resources/native-bundle-manifest.json"), "utf8"));
    assert(native.mode === "portable-native-bundle-v1", ".deb native manifest has the wrong mode");
    assert(native.ldacHelperIncluded === true, ".deb does not carry the LDAC helper required for all eleven codecs");
    const texts = files.filter(file => /(\.json|\.txt|\.md|VERSION\.txt)$/i.test(file));
    const privatePaths = [];
    for (const relative of texts) {
      const text = await fs.readFile(path.join(app, "resources", relative), "utf8").catch(() => "");
      if (/\/home\/[^/\s]+\/Project\//.test(text)) privatePaths.push(relative);
    }
    assert(privatePaths.length === 0, `.deb contains developer checkout paths: ${privatePaths.join(", ")}`);
    return Object.freeze({
      path: debPath,
      materials,
      packageVersion: versionLine,
      files: files.length,
      appBytes: await (async () => {
        let total = 0;
        for (const relative of await walk(app)) total += (await fs.stat(path.join(app, relative))).size;
        return total;
      })(),
      browserCodecAssets: distribution.browserCodecAssets,
      nativeBundle: native.mode,
      ldacHelperIncluded: native.ldacHelperIncluded,
    });
  } finally {
    await fs.rm(extraction, { recursive: true, force: true });
  }
}

export async function verifyWindowsZip(zipPath) {
  const zip = await verifyZip(zipPath, { captureMetadata: true });
  const entries = new Map(zip.entries.map(entry => [entry.name, entry]));
  for (const required of [
    "Audivane.exe", "resources/distribution.json", "resources/native-bundle-manifest.json",
    "resources/process-host/audivane-process-host.exe",
    "resources/third_party/ffmpeg/bin/ffmpeg.exe", "resources/third_party/ffmpeg/bin/ffprobe.exe",
    "resources/third_party/ldac/bin/ldac_helper.exe", "LICENSE", "LICENSES.chromium.html",
  ]) {
    assert(entries.has(required), `Windows ZIP is missing ${required}`);
  }
  assert([...entries.keys()].every(name => !/(^|\/)(codec-assets\/|ffmpeg-core\.(js|wasm)$|lc3_codec\.(js|wasm)$|ldac_codec\.(js|wasm)$)/i.test(name)), "Windows ZIP contains browser-only or developer files");
  const distribution = JSON.parse(zip.contents["resources/distribution.json"].toString("utf8"));
  assert(distribution.processHost?.path === "process-host/audivane-process-host.exe", "Windows ZIP distribution metadata lacks the process lifetime host");
  const processHostEntry = entries.get("resources/process-host/audivane-process-host.exe");
  assert(processHostEntry.sha256 === distribution.processHost.sha256, "Windows ZIP process lifetime host hash disagrees with distribution metadata");
  assert(processHostEntry.bytes === distribution.processHost.bytes, "Windows ZIP process lifetime host size disagrees with distribution metadata");
  const hashes = new Map(zip.entries.filter(item => item.name.startsWith("resources/")).map(item => [item.name.slice(10), item.sha256]));
  const materials = await verifyResourceMaterials({ platform: "win32", hashes, read: async relative => {
    const bytes = zip.contents[`resources/${relative}`];
    if (!bytes) throw new Error(`Missing Windows ZIP material metadata: ${relative}`);
    return bytes;
  } });
  return Object.freeze({ path: zipPath, materials, entries: zip.entries.length, size: zip.size, sha256: zip.sha256 });
}

export async function verifyNsisScript(scriptPath) {
  const text = await fs.readFile(scriptPath, "utf8");
  assert(/RequestExecutionLevel user/.test(text), "NSIS installer is not per-user");
  assert(!/RequestExecutionLevel admin/i.test(text), "NSIS installer requests administrator rights");
  assert(/\$LOCALAPPDATA\\Programs\\Audivane/.test(text), "NSIS installer is not per-user under LOCALAPPDATA");
  assert(/SetShellVarContext current/.test(text), "NSIS installer does not target the current user context");
  assert(/Uninstall\.exe/.test(text), "NSIS installer does not write an uninstaller");
  assert(!/--no-sandbox/.test(text), "NSIS installer disables the Chromium sandbox");
  return Object.freeze({ path: scriptPath, perUser: true });
}
