import { DataTypes, Model } from "sequelize";
import { sequelize } from "../config/database.js";

export class Zone extends Model {
  declare id: string;
  declare name: string;
  declare centerLat: number;
  declare centerLng: number;
  declare radius: number;
}

Zone.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    name: { type: DataTypes.STRING, allowNull: false },
    centerLat: { type: DataTypes.DECIMAL, allowNull: false },
    centerLng: { type: DataTypes.DECIMAL, allowNull: false },
    radius: { type: DataTypes.DECIMAL, allowNull: false },
  },
  {
    sequelize,
    tableName: "zones",
    timestamps: true,
  }
);
