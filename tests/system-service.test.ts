import 'reflect-metadata';
import { GatewayConfig } from '../src/config';
import { SystemService } from '../src/application/services/SystemService';
import pkg from '../package.json';
let service: SystemService;
beforeEach(() => { service = new SystemService(Object.assign(new GatewayConfig(), { centre_code: 'TEST', storage_root: '/nonexistent', database_path: '/nonexistent/db' })); });
afterEach(() => service.stop());
test('config includes only loaded configuration and runtime metadata', () => {
    const value = service.config();
    expect(value.config).toMatchObject({ centre_code: 'TEST', retention_keep_count: 10 });
    expect(value.package_version).toBe(pkg.version); expect(value.node_version).toBe(process.version);
    expect(JSON.stringify(value)).not.toMatch(/jwt\.|access_secret|refresh_secret/);
});
test('first device read produces finite process measurements and nullable storage measurements', async () => {
    const { current, history } = await service.device();
    for (const key of ['cpu_percent', 'rss_bytes', 'heap_used_bytes', 'heap_total_bytes', 'external_bytes', 'event_loop_p95_ms'] as const) expect(Number.isFinite(current[key])).toBe(true);
    expect(current.free_bytes).toBeNull(); expect(current.database_bytes).toBeNull();
    expect(Date.parse(current.sampled_at)).not.toBeNaN(); expect(history).toEqual([current]);
});
test('keeps only the last twelve samples in order', async () => {
    const samples = []; for (let i = 0; i < 15; i++) samples.push(await service.sample());
    const device = await service.device(); expect(device.history).toEqual(samples.slice(3)); expect(device.current).toEqual(samples[14]);
});
test('start is idempotent, timer is unrefed, and stop allows a restart', () => {
    const interval = jest.spyOn(global, 'setInterval');
    try { service.start(); service.start(); expect(interval).toHaveBeenCalledTimes(1); service.stop(); service.start(); expect(interval).toHaveBeenCalledTimes(2); }
    finally { interval.mockRestore(); }
});
