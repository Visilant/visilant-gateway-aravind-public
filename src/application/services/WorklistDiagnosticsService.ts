import { Service } from 'typedi';
import { WorklistService } from './WorklistService';
import { DiagnosticsService } from './DiagnosticsService';
import pkg from '../../../package.json';

@Service()
export class WorklistDiagnosticsService {
    constructor(private readonly worklist: WorklistService, private readonly diagnostics: DiagnosticsService) {}
    report() {
        // An explicit allowlist: no raw configuration, paths, errors or clinical IDs.
        const build = process.env.GATEWAY_BUILD_ID;
        return { schema_version: 1, generated_at: new Date().toISOString(),
            build: build && /^[a-f0-9]{40} \/ [0-9T:.Z+-]+(?: \(modified\))?$/.test(build) ? build : 'unverified',
            package_version: pkg.version, node_version: process.version,
            process_started_at: new Date(Date.now() - process.uptime() * 1000).toISOString(),
            recording: this.diagnostics.status().enabled,
            capabilities: { worklist_explanation: 1, phone_display: 'not_observed', hospital_completion: 'not_integrated' },
            history_limit: 20, history_survives_restart: false, checks: this.worklist.recent() };
    }
}
