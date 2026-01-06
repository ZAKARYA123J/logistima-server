import express from "express";
const PORT = 3000;
const app = express();
import { sequelize } from "./config/database.js";
async function bootstrap() {
    try {
        await sequelize.authenticate();
        console.log('Database authenticate');
    }
    catch (err) {
        console.error("database failed");
        process.exit(1);
    }
}
bootstrap();
app.listen(PORT, () => {
    console.log(`Server is Runing on ${PORT}`);
});
//# sourceMappingURL=main.js.map