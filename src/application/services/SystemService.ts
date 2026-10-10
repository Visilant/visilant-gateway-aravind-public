import path from 'path';
import { Inject, Service } from 'typedi';
import type { GatewayConfig } from '../../config';
import { createResourceSampler, ProcessSample, storageSample } from '../../infrastructure/diagnostics/sampler';
import { CONFIG } from '../../tokens';
import pkg from '../../../package.json';

export interface ResourceSample extends ProcessSample { free_bytes: number | null; database_bytes: number | null; sampled_at: string }
export interface ConfigSnapshotDto { config: GatewayConfig; node_version: string; package_version: string; uptime_seconds: number; diagnostics_env_dir: string | null }
@Service()
export class SystemService {
    private sampler?: ReturnType<typeof createResourceSampler>;
    private timer?: NodeJS.Timeout;
    private history: ResourceSample[] = [];
    private sampling?: Promise<ResourceSample>;
    constructor(@Inject(CONFIG) private readonly settings: GatewayConfig) {}
    start(intervalMs = 5000): void {
        if (this.timer) return;
        this.timer = setInterval(() => { void this.sample().catch(() => undefined); }, intervalMs);
        this.timer.unref();
    }
    stop(): void {
        clearInterval(this.timer); this.timer = undefined;
        this.sampler?.dispose(); this.sampler = undefined;
    }
    sample(): Promise<ResourceSample> {
        // A slow filesystem must not overlap probes or scramble history order.
        if (!this.sampling) this.sampling = this.takeSample().finally(() => { this.sampling = undefined; });
        return this.sampling;
    }
    private async takeSample(): Promise<ResourceSample> {
        this.sampler ??= createResourceSampler();
        const processSample = this.sampler.sample();
        const storage = await storageSample(path.resolve(this.settings.storage_root), path.resolve(this.settings.database_path));
        const value = { ...processSample, ...storage, sampled_at: new Date().toISOString() };
        this.history.push(value);
        if (this.history.length > 12) this.history.shift();
        return value;
    }
    async device(): Promise<{ current: ResourceSample; history: ResourceSample[] }> {
        if (!this.history.length) await this.sample();
        return { current: this.history[this.history.length - 1], history: [...this.history] };
    }
    config(): ConfigSnapshotDto {
        return { config: this.settings, node_version: process.version, package_version: pkg.version, uptime_seconds: process.uptime(), diagnostics_env_dir: process.env.GATEWAY_DIAGNOSTICS_DIR ?? null };
    }
}
