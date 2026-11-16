import { promises as fs } from 'fs';
import { Service } from 'typedi';

@Service()
export class DiskSpace {
    // Free bytes for this process on the emptiest of these folders' disks, or null when
    // none can be read.
    async freeBytes(paths: string[]): Promise<number | null> {
        const results = await Promise.allSettled(paths.map((p) => fs.statfs(p)));
        const free = results.flatMap((r) => r.status === 'fulfilled' ? [Number(r.value.bavail) * Number(r.value.bsize)] : []);
        return free.length ? Math.min(...free) : null;
    }
}
