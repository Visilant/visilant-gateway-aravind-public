import type { ChildProcess } from 'child_process';
import { SHUTDOWN_MESSAGE } from '../shutdown';

// Asks the gateway child to stop over IPC, so it can write gateway.stopped and close the
// database, and kills it only if it has not exited within `timeoutMs`.
export async function stopChild(child: ChildProcess, timeoutMs: number): Promise<'graceful' | 'killed' | 'exited'> {
    if (child.exitCode !== null || child.signalCode !== null) return 'exited';
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    if (child.connected) child.send(SHUTDOWN_MESSAGE, () => undefined);
    else child.kill();
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), timeoutMs); });
    const outcome = await Promise.race([exited.then(() => 'exit' as const), timedOut]);
    clearTimeout(timer);
    if (outcome === 'exit') return 'graceful';
    child.kill();
    await exited;
    return 'killed';
}
