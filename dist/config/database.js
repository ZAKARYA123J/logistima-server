// src/database/sequelize.ts
import { Sequelize } from 'sequelize-typescript';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
// ESM replacement for __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
export const sequelize = new Sequelize({
    dialect: 'postgres',
    host: process.env.DB_HOST ?? 'localhost',
    port: Number(process.env.DB_PORT) || 5432,
    database: process.env.DB_NAME ?? 'my_database',
    username: process.env.DB_USER ?? 'postgres',
    password: process.env.DB_PASSWORD ?? 'password',
    models: [join(__dirname, '../models')],
    logging: false,
});
//# sourceMappingURL=database.js.map