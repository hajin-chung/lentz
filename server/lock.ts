import { open, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';

/** State is intentionally single-process; refuse a second writer instead of losing layouts. */
export async function acquireLock(directory: string): Promise<() => Promise<void>> {
  const file = path.join(directory, 'server.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(file, 'wx', 0o600);
      await handle.writeFile(String(process.pid));
      await handle.close();
      return async () => {
        if ((await readFile(file, 'utf8').catch(() => '')) === String(process.pid))
          await unlink(file);
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const pid = Number(await readFile(file, 'utf8').catch(() => ''));
      let alive = true;
      if (pid > 0)
        try {
          process.kill(pid, 0);
        } catch (error) {
          alive = (error as NodeJS.ErrnoException).code !== 'ESRCH';
        }
      if (alive)
        throw new Error(
          `Another Lentz server uses ${directory}. Stop it or choose a different --data-dir.`,
        );
      await unlink(file).catch(() => {});
    }
  }
  throw new Error('Could not acquire the workspace storage lock.');
}
