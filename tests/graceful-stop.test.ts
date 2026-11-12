import { fork } from 'child_process';
import { EventEmitter } from 'events';
import path from 'path';
import { SHUTDOWN_MESSAGE, onShutdownRequest } from '../src/shutdown';
import { stopChild } from '../src/setup/child-stop';

// On Windows, child.kill('SIGTERM') is TerminateProcess: no handler runs and
// gateway.stopped is never written. The launcher asks over IPC instead.

function child(mode: 'graceful' | 'stubborn') {
    const proc = fork(path.join(__dirname, 'fixtures/ipc-child.js'), [mode], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const ready = new Promise<void>((resolve) => proc.once('message', () => resolve()));
    return { proc, ready };
}

test('stopChild asks over IPC and the child exits on its own', async () => {
    const { proc, ready } = child('graceful');
    await ready;
    const acknowledged = new Promise((resolve) => proc.on('message', (m) => { if ((m as { type: string }).type === 'test.acknowledged') resolve(true); }));
    expect(await stopChild(proc, 5_000)).toBe('graceful');
    expect(await acknowledged).toBe(true);
    expect(proc.exitCode).toBe(0);
});

test('stopChild kills a child that does not exit in time', async () => {
    const { proc, ready } = child('stubborn');
    await ready;
    expect(await stopChild(proc, 300)).toBe('killed');
    expect(proc.killed || proc.signalCode !== null).toBe(true);
});

test('stopChild on a child already gone returns at once', async () => {
    const { proc, ready } = child('graceful');
    await ready;
    proc.kill();
    await new Promise((resolve) => proc.once('exit', resolve));
    expect(await stopChild(proc, 5_000)).toBe('exited');
});

describe('onShutdownRequest', () => {
    function fakeProcess() {
        return Object.assign(new EventEmitter(), { connected: true }) as unknown as NodeJS.Process;
    }

    test.each([
        ['the launcher message', (p: EventEmitter) => p.emit('message', SHUTDOWN_MESSAGE), 'launcher'],
        ['SIGTERM', (p: EventEmitter) => p.emit('SIGTERM'), 'SIGTERM'],
        ['SIGINT', (p: EventEmitter) => p.emit('SIGINT'), 'SIGINT'],
        ['the launcher going away', (p: EventEmitter) => p.emit('disconnect'), 'launcher_gone'],
    ])('%s asks for a clean shutdown, once', (_name, trigger, reason) => {
        const proc = fakeProcess();
        const handler = jest.fn();
        onShutdownRequest(handler, proc);
        trigger(proc as unknown as EventEmitter);
        trigger(proc as unknown as EventEmitter);
        (proc as unknown as EventEmitter).emit('SIGTERM');
        expect(handler).toHaveBeenCalledTimes(1);
        expect(handler).toHaveBeenCalledWith(reason);
    });

    test('ignores other messages', () => {
        const proc = fakeProcess();
        const handler = jest.fn();
        onShutdownRequest(handler, proc);
        (proc as unknown as EventEmitter).emit('message', { type: 'something.else' });
        (proc as unknown as EventEmitter).emit('message', 'gateway.shutdown');
        expect(handler).not.toHaveBeenCalled();
    });
});
