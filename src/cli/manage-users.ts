import 'reflect-metadata';
import { randomBytes } from 'crypto';
import bcrypt from 'bcryptjs';
import Container from 'typedi';
import { v4 as uuidv4 } from 'uuid';
import { loadConfig } from '../config';
import { createDatabase } from '../infrastructure/database';
import { UserRepository } from '../infrastructure/database/repositories';
import { createLogger } from '../infrastructure/logger';
import { CONFIG, DATABASE, LOGGER } from '../tokens';

// Operator accounts are created here rather than synced from anywhere: the gateway has
// no cloud to pull from, and it must keep working with the hospital's internet down.
//
//   npm run users -- add <email> <username> [--admin] [--password <pw>]
//   npm run users -- passwd <email> [--password <pw>]
//   npm run users -- list
//
// Omitting --password generates one and prints it once. That is deliberate: a password
// typed on the command line ends up in the shell history of a machine in a clinic.

const BCRYPT_ROUNDS = 12;

function flag(args: string[], name: string): string | undefined {
    const index = args.indexOf(`--${name}`);
    return index >= 0 ? args[index + 1] : undefined;
}

async function main(): Promise<void> {
    const [command, ...args] = process.argv.slice(2);
    const logger = createLogger();
    const config = loadConfig();

    Container.set(LOGGER, logger);
    Container.set(CONFIG, config);
    const database = await createDatabase(config, logger);
    Container.set(DATABASE, database);

    const users = Container.get(UserRepository);

    try {
        switch (command) {
            case 'add': {
                const [email, username] = args;
                if (!email || !username) throw new Error('usage: add <email> <username> [--admin] [--password <pw>]');

                if (await users.findByEmail(email)) throw new Error(`a user with email ${email} already exists`);
                if (await users.findByUsername(username)) throw new Error(`username ${username} is taken`);

                const password = flag(args, 'password') ?? randomBytes(9).toString('base64url');
                await users.create({
                    id: uuidv4(),
                    email: email.trim().toLowerCase(),
                    username: username.trim().toLowerCase(),
                    password: await bcrypt.hash(password, BCRYPT_ROUNDS),
                    display_name: username,
                    role: args.includes('--admin') ? 'ADMIN' : 'OPERATOR',
                    active: true,
                    created_at: new Date().toISOString(),
                } as never);

                console.log(`created ${email}`);
                if (!flag(args, 'password')) console.log(`password: ${password}   (shown once)`);
                break;
            }

            case 'passwd': {
                const [email] = args;
                if (!email) throw new Error('usage: passwd <email> [--password <pw>]');

                const user = await users.findByEmail(email);
                if (!user) throw new Error(`no user with email ${email}`);

                const password = flag(args, 'password') ?? randomBytes(9).toString('base64url');
                await users.updatePassword(user.id, await bcrypt.hash(password, BCRYPT_ROUNDS));

                console.log(`password updated for ${email}`);
                if (!flag(args, 'password')) console.log(`password: ${password}   (shown once)`);
                break;
            }

            case 'list': {
                const count = await users.count();
                console.log(`${count} user(s)`);
                break;
            }

            default:
                throw new Error('usage: add | passwd | list');
        }
    } finally {
        await database.destroy();
    }
}

main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
});
