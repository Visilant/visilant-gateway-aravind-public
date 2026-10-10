import os from 'os';
import type { GatewayConfig } from '../src/config';
import { HealthService } from '../src/application/services/HealthService';
import { HealthController } from '../src/presentation/controllers/health.controller';

const config = { centre_code: 'VC1', storage_root: os.tmpdir(), mwl: {}, store: {} } as GatewayConfig;
const database = { query: jest.fn().mockResolvedValue([]) };
const repository = { countByStatus: jest.fn() };
const dicom = { echo: jest.fn().mockResolvedValue(undefined) };
const counts = { PENDING: 0, SENDING: 0, SENT: 0, FAILED: 0 };
let service: HealthService;
beforeEach(() => {
    repository.countByStatus.mockResolvedValue(counts);
    service = new HealthService(config, database as never, repository as never, dicom as never);
});

it('is healthy when the nodes and storage work and nothing is parked', async () => {
    const report = await service.report();
    expect(report.status).toBe('ok');
    expect(report.detail).toBeUndefined();
    expect(report.queue).toEqual(counts);
});

it('is degraded with a count when captures need attention, even with reachable PACS', async () => {
    repository.countByStatus.mockResolvedValue({ ...counts, FAILED: 2 });
    const report = await service.report();
    expect(report.status).toBe('degraded');
    expect(report.detail).toBe('2 captures need attention');
    expect(report.dicom.store.reachable).toBe(true);
    const response = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
    await new HealthController(service).health(response as never);
    expect(response.status).toHaveBeenCalledWith(503);
});

it('does not report healthy if queue inspection fails', async () => {
    repository.countByStatus.mockRejectedValueOnce(new Error('queue read failed'));
    const report = await service.report();
    expect(report.status).toBe('degraded');
    expect(report.queue).toBeNull();
});
