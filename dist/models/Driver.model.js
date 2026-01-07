import { DataTypes, Model } from "sequelize";
import { sequelize } from "../config/database.js";
export var DriverStatus;
(function (DriverStatus) {
    DriverStatus["AVAILABLE"] = "available";
    DriverStatus["BUSY"] = "busy";
    DriverStatus["OFFLINE"] = "offline";
})(DriverStatus || (DriverStatus = {}));
export class Driver extends Model {
}
Driver.init({
    id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
    },
    name: { type: DataTypes.STRING, allowNull: false },
    phone: { type: DataTypes.STRING, allowNull: false },
    latitude: { type: DataTypes.DECIMAL, allowNull: false },
    longitude: { type: DataTypes.DECIMAL, allowNull: false },
    capacity: { type: DataTypes.INTEGER, allowNull: false },
    status: {
        type: DataTypes.ENUM(...Object.values(DriverStatus)),
        allowNull: false,
    },
    zoneId: {
        type: DataTypes.UUID,
        allowNull: false,
    },
}, {
    sequelize,
    tableName: "drivers",
    timestamps: true,
});
