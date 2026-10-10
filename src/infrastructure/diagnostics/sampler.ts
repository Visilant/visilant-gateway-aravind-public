import { promises as fs } from 'fs';
import { monitorEventLoopDelay, performance } from 'perf_hooks';

export interface ProcessSample {
    cpu_percent: number;
    rss_bytes: number;
    heap_used_bytes: number;
    heap_total_bytes: number;
    external_bytes: number;
    event_loop_p95_ms: number;
}

// Delta-based process sampler. One instance per consumer: the histogram is reset on
// every sample, so two readers sharing one would halve each other's window.
export function createResourceSampler(): { sample(): ProcessSample; dispose(): void } {
    const delay = monitorEventLoopDelay({ resolution: 20 });
    delay.enable();
    let previousCpu = process.cpuUsage();
    let previousTime = performance.now();
    return {
        sample(): ProcessSample {
            const now = performance.now();
            const cpu = process.cpuUsage();
            const memory = process.memoryUsage();
            const elapsedMs = Math.max(now - previousTime, 1);
            const sample = {
                cpu_percent: ((cpu.user - previousCpu.user + cpu.system - previousCpu.system) / 1000) / elapsedMs * 100,
                rss_bytes: memory.rss,
                heap_used_bytes: memory.heapUsed,
                heap_total_bytes: memory.heapTotal,
                external_bytes: memory.external,
                event_loop_p95_ms: delay.percentile(95) / 1e6,
            };
            previousTime = now;
            previousCpu = cpu;
            delay.reset();
            return sample;
        },
        dispose(): void {
            delay.disable();
        },
    };
}

// Free space under the storage root and the size of the database file. Null when a
// path cannot be read; the gauge shows a dash rather than the page failing.
export async function storageSample(storageRoot: string, databasePath: string): Promise<{ free_bytes: number | null; database_bytes: number | null }> {
    const [storage, databaseFile] = await Promise.allSettled([fs.statfs(storageRoot), fs.stat(databasePath)]);
    return {
        free_bytes: storage.status === 'fulfilled' ? Number(storage.value.bavail) * Number(storage.value.bsize) : null,
        database_bytes: databaseFile.status === 'fulfilled' ? databaseFile.value.size : null,
    };
}
