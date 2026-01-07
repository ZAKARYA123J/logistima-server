import { DataTypes, Model } from "sequelize";
import { sequelize } from "../config/database.js";
export var ParcelStatus;
(function (ParcelStatus) {
    ParcelStatus["PENDING"] = "pending";
    ParcelStatus["ASSIGNED"] = "assigned";
    ParcelStatus["PICKED"] = "picked";
    ParcelStatus["DELIVERED"] = "delivered";
})(ParcelStatus || (ParcelStatus = {}));
export class Parcel extends Model {
}
Parcel.init({
    id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
    },
    trackingCode: { type: DataTypes.STRING, allowNull: false },
    status: {
        type: DataTypes.ENUM(...Object.values(ParcelStatus)),
        allowNull: false,
    },
    pickupAddress: DataTypes.STRING,
    pickupLat: DataTypes.DECIMAL,
    pickupLng: DataTypes.DECIMAL,
    deliveryAddress: DataTypes.STRING,
    deliveryLat: DataTypes.DECIMAL,
    deliveryLng: DataTypes.DECIMAL,
    weight: DataTypes.DECIMAL,
    zoneId: DataTypes.UUID,
    driverId: {
        type: DataTypes.UUID,
        allowNull: true,
    },
}, {
    sequelize,
    tableName: "parcels",
    timestamps: true,
});
