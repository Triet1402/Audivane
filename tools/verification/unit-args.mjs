/** Node stops parsing runner options at the first file; accept flags on either side. */
export function unitArguments(args) {
  const files = [], options = [];
  const takesValue = new Set(['--test-name-pattern', '--test-skip-pattern', '--test-concurrency',
    '--test-timeout', '--test-reporter', '--test-reporter-destination', '--test-shard',
    '--test-isolation', '--test-rerun-failures', '--import', '--require', '-r']);
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--') continue;
    if (takesValue.has(arg)) {
      if (args[index + 1] === undefined) throw new Error(`${arg} requires a value`);
      options.push(arg, args[++index]); continue;
    }
    if (!arg.startsWith('-') && /\.(?:[cm]?js|tsx?)$/.test(arg)) files.push(arg);
    else options.push(arg);
  }
  return { files, options };
}
