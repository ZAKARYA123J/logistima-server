import { DataTypes, Model } from "sequelize";
import { sequelize } from "../config/database.js";
export var DeliveryStatus;
(function (DeliveryStatus) {
    DeliveryStatus["STARTED"] = "started";
    DeliveryStatus["COMPLETED"] = "completed";
    DeliveryStatus["CANCELLED"] = "cancelled";
})(DeliveryStatus || (DeliveryStatus = {}));
export class Delivery extends Model {
}
Delivery.init({
    id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
    },
    parcelId: {
        type: DataTypes.UUID,
        allowNull: false,
    },
    driverId: {
        type: DataTypes.UUID,
        allowNull: false,
    },
    status: {
        type: DataTypes.ENUM(...Object.values(DeliveryStatus)),
        allowNull: false,
    },
    estimatedRoute: DataTypes.TEXT,
    receiptGenerated: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
    },
}, {
    sequelize,
    tableName: "deliveries",
    timestamps: true,
});
