import { DataTypes, Model } from "sequelize";
import { sequelize } from "../config/database.js";

export enum DriverStatus {
  AVAILABLE = "available",
  BUSY = "busy",
  OFFLINE = "offline",
}

export class Driver extends Model {
  declare id: string;
  declare name: string;
  declare phone: string;
  declare latitude: number;
  declare longitude: number;
  declare capacity: number;
  declare status: DriverStatus;
  declare zoneId: string;
}

Driver.init(
  {
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
  },
  {
    sequelize,
    tableName: "drivers",
    timestamps: true,
  }
);
