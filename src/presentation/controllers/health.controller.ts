import type { Response } from 'express';
import { Get, JsonController, Res } from 'routing-controllers';
import { Service } from 'typedi';
import { HealthService } from '../../application/services';

// HTTP only: call the service, return the report. Unauthenticated — an operator needs
// to be able to check the box before they can log into it.
@JsonController('/health')
@Service()
export class HealthController {
    constructor(private readonly healthService: HealthService) {}

    @Get('/')
    async health(@Res() res: Response): Promise<Response> {
        const report = await this.healthService.report();
        return res.status(report.status === 'ok' ? 200 : 503).json(report);
    }
}
