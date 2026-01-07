// src/database/sequelize.ts
import { Sequelize } from 'sequelize-typescript';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
// ESM replacement for __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// Import models directly instead of using paths
// import { User } from '../models/User.js'; // Add .js extension for ESM
// import { Product } from '../models/Product.js'; // Add all your models
export const sequelize = new Sequelize({
    dialect: 'postgres',
    host: process.env.DB_HOST || 'postgres',
    port: Number(process.env.DB_PORT) || 5432,
    database: process.env.DB_NAME || 'app_db',
    username: process.env.DB_USER || 'app_user',
    password: process.env.DB_PASSWORD || 'root',
    //   models: [User, Product], // Pass model classes directly
    logging: console.log, // Enable logging to see connection errors
});
