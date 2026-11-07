import { auditWindowsPackage } from "./windows-package-audit.mjs";
import { packager } from "@electron/packager";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { ICONS, PRODUCT, normalizePlatform, platformConfig, root as repositoryRoot, unpackedDirectory } from "../distribution/config.mjs";
import { assertNativeBundleOutsideOutputs, desktopBuildOutputDirectories, resolveNativeBundleRequest, stageNativeBundle, verifyPackagedNativeBundle } from "./native-bundle.mjs";
import { WINDOWS_PROCESS_HOST_RELATIVE, resolveWindowsProcessHost, stageWindowsProcessHost } from "./process-host.mjs";

const root = repositoryRoot;
const APP_LICENSE_FILES = ["LICENSE", "THIRD_PARTY_NOTICES.md", "packages/measurements/NOTICE.md"];

function packageManifest(workspace, platform) {
  return {
    name: platform === "win32" ? "audivane-desktop" : "codec-abx-desktop",
    productName: PRODUCT.name,
    version: workspace.version,
    license: workspace.license,
    main: "dist/main.cjs",
    description: `${PRODUCT.subtitle} Local native codec ABX listening.`,
  };
}

async function assertDistributionContents(directory, platform) {
  const app = path.join(directory, "resources/app");
  const client = path.join(app, "dist/client");
  const codecAssets = path.join(client, "codec-assets");
  await fs.access(path.join(app, "dist/main.cjs"));
  await fs.access(path.join(app, "dist/runtime-worker.cjs"));
  for (const name of ["LICENSE", "THIRD_PARTY_NOTICES.md", "measurements-NOTICE.md"]) {
    await fs.access(path.join(app, name));
  }
  // Desktop execution is native. The browser WASM/core assets are intentionally
  // not shipped, so a package that still contains them is a packaging error.
  const present = await fs.lstat(codecAssets).catch(() => null);
  if (present) throw new Error(`Desktop package contains excluded browser codec assets: ${path.relative(root, codecAssets)}`);
  const entries = await fs.readdir(client, { recursive: true });
  const leaked = entries.filter(name => /(^|[\\/])(ffmpeg-core\.(js|wasm)|lc3_codec\.(js|wasm)|ldac_codec\.(js|wasm))$/.test(String(name)));
  if (leaked.length > 0) throw new Error(`Desktop package contains excluded browser assets: ${leaked.join(", ")}`);
  const fonts = entries.filter(name => /\.woff2$/i.test(String(name)));
  if (fonts.length === 0) throw new Error("Desktop package lost the bundled self-hosted font assets");
  if (platform === "win32") {
    await fs.access(path.join(directory, "resources", WINDOWS_PROCESS_HOST_RELATIVE));
  }
}

export async function packageDesktop(options = {}) {
  const platform = normalizePlatform(options.platform ?? "linux");
  const arch = options.arch ?? "x64";
  const configuration = platformConfig(platform);
  if (arch !== configuration.arch) throw new Error(`Only ${configuration.arch} packaging is implemented for ${platform}`);
  const workspace = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
  const nativeBundle = options.nativeBundle === undefined ? resolveNativeBundleRequest() : options.nativeBundle;
  if (options.requireNativeBundle && !nativeBundle) {
    throw new Error("Distribution packaging requires an explicit prepared native bundle; PATH discovery and downloads are not used");
  }
  if (nativeBundle) await assertNativeBundleOutsideOutputs(nativeBundle, desktopBuildOutputDirectories(root));
  const nativeStaging = path.join(root, `build/desktop-native-bundle/${platform}-${arch}`);
  // Validate and stage an explicitly supplied native resource tree before any
  // previous package output is removed. A failure cannot inherit a success stamp
  // or look like a completed package from an earlier run.
  const staged = nativeBundle ? await stageNativeBundle(nativeBundle, nativeStaging, { platform }) : null;
  if (!staged) await fs.rm(nativeStaging, { recursive: true, force: true });
  const staging = path.join(root, `build/desktop-package/${platform}-${arch}`);
  const processHostStaging = path.join(root, `build/desktop-process-host/${platform}-${arch}`);
  const outputRoot = path.join(root, "dist/desktop");
  const output = unpackedDirectory(platform);
  // Only owned generated build/output paths are cleaned. Other platform output
  // directories are retained so independent artifact builds can coexist.
  await fs.rm(staging, { recursive: true, force: true });
  await fs.rm(processHostStaging, { recursive: true, force: true });
  await fs.rm(output, { recursive: true, force: true });
  await fs.mkdir(staging, { recursive: true });
  await fs.cp(path.join(root, "apps/desktop/dist"), path.join(staging, "dist"), { recursive: true });
  for (const name of ["LICENSE", "THIRD_PARTY_NOTICES.md"]) {
    await fs.copyFile(path.join(root, name), path.join(staging, name));
  }
  await fs.copyFile(path.join(root, "packages/measurements/NOTICE.md"), path.join(staging, "measurements-NOTICE.md"));
  await fs.cp(path.join(root, "assets/brand/icons"), path.join(staging, "icons"), { recursive: true });
  await fs.writeFile(path.join(staging, "package.json"), JSON.stringify(packageManifest(workspace, platform)));
  const icon = platform === "win32" ? path.join(root, ICONS.ico) : path.join(root, ICONS.png512);
  // The Windows lifetime host is app-owned, not a third-party codec. It is a
  // hard packaging input for win32 so a distribution cannot silently omit the
  // Job Object authority.
  const processHost = platform === "win32"
    ? await stageWindowsProcessHost(resolveWindowsProcessHost(root), processHostStaging)
    : null;
  const extraResource = [
    path.join(staging, "icons"),
    ...(processHost === null ? [] : [path.join(processHostStaging, "process-host")]),
    ...(staged ? staged.extraResource : []),
  ];
  const paths = await packager({
    dir: staging,
    out: outputRoot,
    name: configuration.unpackedName,
    executableName: configuration.unpackedExecutable,
    platform: configuration.electronPlatform,
    arch,
    electronVersion: "45.1.0",
    overwrite: true,
    asar: false,
    prune: false,
    icon,
    ...(platform === "win32" ? {
      win32metadata: {
        CompanyName: PRODUCT.name,
        FileDescription: `${PRODUCT.name} — ${PRODUCT.subtitle}`,
        ProductName: PRODUCT.name,
        InternalName: configuration.unpackedExecutable,
        OriginalFilename: `${configuration.unpackedExecutable}.exe`,
      },
    } : {}),
    extraResource,
  });
  const packaged = paths[0];
  if (path.resolve(packaged) !== path.resolve(output)) {
    throw new Error(`Packager produced an unexpected output path: ${packaged}`);
  }
  if (staged) {
    // The packaged resources, not the staging tree, are the release artifact.
    // Compare exact hashes and the manifest before reporting success.
    await verifyPackagedNativeBundle(path.join(packaged, "resources"), staged.inspection);
  }
  await assertDistributionContents(packaged, platform);
  if (platform === "win32") {
    const audit = await auditWindowsPackage(packaged);
    await fs.writeFile(path.join(packaged, "resources/windows-package-audit.json"), JSON.stringify(audit, null, 2) + "\n");
  }
  const manifestBytes = staged ? await fs.readFile(staged.manifestPath) : null;
  const distribution = {
    schema: "codec-abx-desktop-distribution-v1",
    product: PRODUCT.name,
    subtitle: PRODUCT.subtitle,
    version: workspace.version,
    license: workspace.license,
    platform,
    arch,
    executable: `${configuration.unpackedExecutable}${platform === "win32" ? ".exe" : ""}`,
    browserCodecAssets: "excluded-native-only",
    nativeBundle: staged ? {
      mode: staged.inspection.mode,
      manifestSha256: createHash("sha256").update(manifestBytes).digest("hex"),
      ldacHelperIncluded: staged.inspection.ldacHelperIncluded,
    } : { mode: "external-native-tools-v1", manifestSha256: null, ldacHelperIncluded: false },
    ...(processHost === null ? {} : {
      processHost: {
        path: processHost.path,
        bytes: processHost.bytes,
        sha256: processHost.sha256,
      },
    }),
  };
  await fs.writeFile(path.join(packaged, "resources/distribution.json"), `${JSON.stringify(distribution, null, 2)}\n`);
  console.log(packaged);
}

export { APP_LICENSE_FILES };
