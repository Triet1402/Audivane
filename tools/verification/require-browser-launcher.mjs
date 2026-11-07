export default function requireBrowserLauncher() {
  if (!process.env.CODEC_ABX_DEV_URL || !process.env.CODEC_ABX_PREVIEW_URL) {
    throw new Error('Run npm run test:browser -- [Playwright arguments] so owned servers, build locks and unique reports are configured.');
  }
}
