import express from "express";
import redis from "redis";

const PORT = 3000;
const app = express();
import { sequelize } from "./config/database.js";

const redisUrl = 'redis://localhost:6379';
const client = redis.createClient({ url: redisUrl });

client.on("error", (error) => {
    console.error("Redis ERROR***", error);
});

client.on("connect", () => {
    console.log("Redis connected.");
});

(async () => {
    await client.connect();
})();

async function bootstrap() {
    const MAX_RETRIES = 20;
    const RETRY_DELAY = 5000; // 5 seconds
    
    for (let i = 0; i < MAX_RETRIES; i++) {
        try {
            await sequelize.authenticate();
            console.log('Database authenticated');
            return; // Connection successful
        } catch (err) {
            console.error(`Database connection failed (attempt ${i + 1}/${MAX_RETRIES})`);
            if (i === MAX_RETRIES - 1) {
                console.error("Max retries reached. Exiting.", err);
                process.exit(1);
            }
            await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
        }
    }
}

bootstrap();

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});