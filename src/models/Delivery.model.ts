import { DataTypes, Model } from "sequelize";
import { sequelize } from "../config/database.js";

export enum DeliveryStatus {
  STARTED = "started",
  COMPLETED = "completed",
  CANCELLED = "cancelled",
}

export class Delivery extends Model {
  declare id: string;
  declare parcelId: string;
  declare driverId: string;
  declare status: DeliveryStatus;
  declare estimatedRoute: string;
  declare receiptGenerated: boolean;
}

Delivery.init(
  {
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
  },
  {
    sequelize,
    tableName: "deliveries",
    timestamps: true,
  }
);
