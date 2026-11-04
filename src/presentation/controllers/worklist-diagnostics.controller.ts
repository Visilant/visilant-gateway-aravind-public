import { Authorized, Body, CurrentUser, Get, Header, HttpError, JsonController, Post, Put, Res } from 'routing-controllers';
import type { Response } from 'express';
import { Service } from 'typedi';
import { WorklistFiltersDto, SaveWorklistFiltersDto } from '../../application/dto/worklist-diagnostics.dto';
import { WorklistService, WorklistProbeBusyError } from '../../application/services/WorklistService';
import { WorklistSettingsService, StaleWorklistSettingsError } from '../../application/services/WorklistSettingsService';
import { WorklistDiagnosticsService } from '../../application/services/WorklistDiagnosticsService';
import { UserEntity, UserRole } from '../../infrastructure/database/entities';

@JsonController('/diagnostics/worklist')
@Authorized()
@Service()
export class WorklistDiagnosticsController {
    constructor(private readonly worklist: WorklistService, private readonly settings: WorklistSettingsService,
        private readonly diagnostics: WorklistDiagnosticsService) {}
    @Get('/')
    @Header('Cache-Control', 'no-store')
    overview() { return this.diagnostics.report(); }
    @Get('/settings')
    @Header('Cache-Control', 'no-store')
    settingsSnapshot(@CurrentUser() user: UserEntity) {
        return { ...this.settings.snapshot(), can_edit: user.role === UserRole.ADMIN };
    }
    @Post('/check')
    @Header('Cache-Control', 'no-store')
    async check() {
        try { return await this.worklist.probe(); } catch (error) { throw mapError(error); }
    }
    @Post('/inspect')
    @Header('Cache-Control', 'no-store')
    @Authorized(UserRole.ADMIN)
    async inspect() {
        try { return await this.worklist.inspect(); } catch (error) { throw mapError(error); }
    }
    @Post('/preview')
    @Header('Cache-Control', 'no-store')
    @Authorized(UserRole.ADMIN)
    async preview(@Body() body: WorklistFiltersDto) {
        try { return await this.worklist.probe(body); } catch (error) { throw mapError(error); }
    }
    @Put('/settings')
    @Header('Cache-Control', 'no-store')
    @Authorized(UserRole.ADMIN)
    async save(@Body() body: SaveWorklistFiltersDto) {
        try { return await this.settings.save(body); } catch (error) { throw mapError(error); }
    }
    @Post('/settings/reset')
    @Header('Cache-Control', 'no-store')
    @Authorized(UserRole.ADMIN)
    async reset(@Body() body: SaveWorklistFiltersDto) {
        try { return await this.settings.save(body, true); } catch (error) { throw mapError(error); }
    }
    @Get('/support')
    @Header('Cache-Control', 'no-store')
    support(@Res() res: Response) {
        res.set({ 'Content-Disposition': 'attachment; filename="gateway-worklist-support.json"', 'Cache-Control': 'no-store' });
        return res.json(this.diagnostics.report());
    }
}

function mapError(error: unknown): unknown {
    return error instanceof WorklistProbeBusyError || error instanceof StaleWorklistSettingsError ?
        new HttpError(409, error.message) : error;
}
