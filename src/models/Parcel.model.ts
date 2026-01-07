import { DataTypes, Model } from "sequelize";
import { sequelize } from "../config/database.js";

export enum ParcelStatus {
  PENDING = "pending",
  ASSIGNED = "assigned",
  PICKED = "picked",
  DELIVERED = "delivered",
}

export class Parcel extends Model {
  declare id: string;
  declare trackingCode: string;
  declare status: ParcelStatus;
  declare pickupAddress: string;
  declare pickupLat: number;
  declare pickupLng: number;
  declare deliveryAddress: string;
  declare deliveryLat: number;
  declare deliveryLng: number;
  declare weight: number;
  declare zoneId: string;
  declare driverId: string | null;
}

Parcel.init(
  {
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
  },
  {
    sequelize,
    tableName: "parcels",
    timestamps: true,
  }
);
