import { promises as fs } from "node:fs";

/** Internal Linux proc-stat classifier; dead members await host parent reaping. */
export function procStatHasLiveOwnedMember(stat: string, pid: number, detached: boolean): boolean {
  const open = stat.indexOf("("), close = stat.lastIndexOf(")");
  if (open < 1 || close <= open) throw new Error("Invalid native process stat");
  const member = Number(stat.slice(0, open).trim());
  const fields = stat.slice(close + 1).trim().split(/\s+/);
  const group = Number(fields[2]), state = fields[0];
  if (!Number.isSafeInteger(member) || member <= 0 || !Number.isSafeInteger(group) ||
      group < 0 || !state || !/^[A-Za-z]$/.test(state)) {
    throw new Error("Invalid native process stat fields");
  }
  const owned = detached ? group === pid : member === pid;
  return owned && state !== "Z" && state !== "X" && state !== "x";
}

/** Runtime-private independent check used by engine and main supervision.
 * Zombie-only groups are stopped, even while kill(group, 0) still succeeds.
 * Inspection failures propagate; uncertainty is never treated as cleanup.
 * Windows has no process groups or zombies; `detached` is false there. The
 * observed leader is the trusted lifetime host, whose kill-on-close Job Object
 * owns the real codec tree. taskkill remains a targeted cancellation signal.
 */
export async function hasLiveOwnedProcess(pid: number, detached: boolean): Promise<boolean> {
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error("Invalid owned native PID");
  try { process.kill(detached && process.platform !== "win32" ? -pid : pid, 0); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
  if (process.platform !== "linux") return true;
  const entries = detached ? await fs.readdir("/proc") : [String(pid)];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    let stat: string;
    try { stat = await fs.readFile(`/proc/${entry}/stat`, "utf8"); }
    catch (error) {
      if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) continue;
      throw error;
    }
    if (procStatHasLiveOwnedMember(stat, pid, detached)) return true;
  }
  return false;
}
