import express from "express"
const PORT = process.env.PORT || 3000;
export const app = express()

app.get('/health', (req, res) => {
    res.status(200).json({ status: "OK" });
});

import {sequelize} from "./config/database.js"
import "../src/models/index.js"

async function bootstrap() {
    const MAX_RETRIES = 20;
    const RETRY_DELAY = 5000; // 5 seconds

    for (let i = 0; i < MAX_RETRIES; i++) {
        try {
           
            await sequelize.authenticate();
            console.log('Database authenticate');
            await sequelize.sync({ alter: true });
            console.log('Database synced');
            return;
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
if (process.env.NODE_ENV !== 'test') {
    bootstrap()
    app.listen(PORT,()=>{
        console.log(`Server is Runing on ${PORT}`)
    })
}
