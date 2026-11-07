import { availableParallelism, totalmem } from "node:os";
import { readFileSync } from "node:fs";
function read(filename: string): string | null {
  try { return readFileSync(filename, "utf8").trim(); } catch { return null; }
}
export function boundedWorkers(cpus: number, memoryBytes: number): number {
  return Math.max(1, Math.min(8, Math.floor(cpus) - 2, Math.floor(memoryBytes / 2 ** 31)));
}
export function browserWorkers(): number {
  let cpus = availableParallelism();
  let memory = totalmem();
  const cpu = read("/sys/fs/cgroup/cpu.max")?.split(/\s+/);
  if (cpu && cpu[0] !== "max" && Number(cpu[1]) > 0) cpus = Math.min(cpus, Number(cpu[0]) / Number(cpu[1]));
  else {
    const quota = Number(read("/sys/fs/cgroup/cpu/cpu.cfs_quota_us"));
    const period = Number(read("/sys/fs/cgroup/cpu/cpu.cfs_period_us"));
    if (quota > 0 && period > 0) cpus = Math.min(cpus, quota / period);
  }
  for (const filename of ["/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes"]) {
    const limit = Number(read(filename));
    if (limit > 0 && Number.isFinite(limit)) memory = Math.min(memory, limit);
  }
  const requested = process.env.CODEC_ABX_BROWSER_WORKERS;
  if (requested && !/^[1-9]\d*$/.test(requested)) throw new Error("CODEC_ABX_BROWSER_WORKERS must be a positive integer");
  return requested ? Number(requested) : process.env.CI ? Math.min(2, boundedWorkers(cpus, memory)) : boundedWorkers(cpus, memory);
}
