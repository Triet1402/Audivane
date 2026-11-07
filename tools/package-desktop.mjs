import { buildArtifacts } from './verification/build.mjs';
import { normalizePlatform } from './distribution/config.mjs';

function takeValue(args, index, name) {
  const value = args[index + 1];
  if (value === undefined || value.length === 0 || value.startsWith('--')) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

const args = process.argv.slice(2);
const options = { platform: 'linux', arch: 'x64' };
for (let index = 0; index < args.length; index += 1) {
  const argument = args[index];
  if (argument === '--native-bundle') {
    const value = takeValue(args, index, '--native-bundle');
    // The build reads this same explicit environment setting so the manifest,
    // cache fingerprint and packaged contents cannot disagree.
    process.env.CODEC_ABX_NATIVE_BUNDLE_DIR = value;
    index += 1;
  } else if (argument === '--platform') {
    options.platform = normalizePlatform(takeValue(args, index, '--platform'));
    index += 1;
  } else if (argument === '--arch') {
    options.arch = takeValue(args, index, '--arch');
    index += 1;
  } else if (argument === '--require-native-bundle') {
    options.requireNativeBundle = true;
  } else if (argument === '--no-native-bundle') {
    delete process.env.CODEC_ABX_NATIVE_BUNDLE_DIR;
  } else {
    throw new Error(`Unknown package:desktop argument: ${argument}`);
  }
}
await buildArtifacts('package', options);
