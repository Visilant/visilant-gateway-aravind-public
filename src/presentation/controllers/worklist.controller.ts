import { Authorized, Get, JsonController, QueryParams } from 'routing-controllers';
import { Service } from 'typedi';
import { WorklistEntryDto, WorklistQueryDto } from '../../application/dto';
import { WorklistService } from '../../application/services';

// Live hospital worklist with gateway-owned screening completion filtering.
@JsonController('/worklist')
@Authorized()
@Service()
export class WorklistController {
    constructor(private readonly worklistService: WorklistService) {}

    @Get('/')
    getWorklist(@QueryParams() query: WorklistQueryDto): Promise<WorklistEntryDto[]> {
        return this.worklistService.getWorklist(query);
    }
}
