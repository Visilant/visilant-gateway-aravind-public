import { Authorized, Get, JsonController } from 'routing-controllers';
import { Service } from 'typedi';
import { SystemService } from '../../application/services/SystemService';

@JsonController('/system')
@Authorized()
@Service()
export class SystemController {
    constructor(private readonly service: SystemService) {}
    @Get('/config') config() { return this.service.config(); }
    @Get('/device') device() { return this.service.device(); }
}
