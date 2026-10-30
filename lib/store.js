/**
 * 持久化的小工具：日期、哈希、锁、读回退。
 *
 * 两个写盘红线（实测过的坑）：
 * 1. 内容写入必须原子：走 io.writeText（宿主端实现为原子替换），不再手写“临时文件 + rename”。
 * 2. 并发导入要锁：靠 io.tryCreate（不存在才写）抢锁，陈锁 30 秒自动丢弃。
 *
 * @module dsh-lit-library/store
 */
import { createHash } from 'node:crypto';

/** 本地日期 YYYY-MM-DD。 */
export function todayISO(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** sha256（十六进制）。 */
export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/** 读文本；不存在或读失败时返回 fallback（不传 fallback 则抛错）。 */
export async function readTextOr(io, abs, fallback) {
  try {
    if (!(await io.exists(abs))) return fallback;
    return await io.readText(abs);
  } catch (error) {
    if (fallback !== undefined) return fallback;
    throw error;
  }
}

/** 读文件哈希（文件不存在时返回 undefined）。 */
export async function hashFile(io, abs) {
  try {
    return sha256Hex(await io.readBytes(abs));
  } catch {
    return undefined;
  }
}

/**
 * 抢锁执行：拿不到锁就等；陈锁（超过 staleMs 没动）直接丢掉再抢。
 *
 * @param io 需要 tryCreate / stat / unlink
 * @param lockPath 锁文件绝对路径（项目根下 .lit.lock）
 * @param fn 临界区内的工作
 */
export async function withLock(io, lockPath, fn, { waitMs = 8000, staleMs = 30000 } = {}) {
  const deadline = Date.now() + waitMs;
  let held = false;
  for (;;) {
    held = await io.tryCreate(lockPath, String(process.pid));
    if (held) break;
    const info = await io.stat(lockPath);
    if (info !== undefined && typeof info.mtimeMs === 'number' && Date.now() - info.mtimeMs > staleMs) {
      await io.unlink(lockPath);
      continue;
    }
    if (Date.now() > deadline) {
      throw new Error('lit: 库里另一个写入还没结束（锁超时：' + lockPath + '）。稍后重试。');
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  try {
    return await fn();
  } finally {
    try {
      await io.unlink(lockPath);
    } catch {
      /* 锁释放失败不该盖掉真正的工作结果 */
    }
  }
}

/** 把任意抛出物转成一句人话。 */
export function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}
