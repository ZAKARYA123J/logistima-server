import express from "express"
import routes from "./routes/index.js"
import {sequelize} from "./config/database.js"
import "./models/index.js"

const PORT = process.env.PORT || 3000;
export const app = express()

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Routes
app.use('/api', routes);

app.get('/health', (_req, res) => {
    res.status(200).json({ status: "OK" });
});

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
